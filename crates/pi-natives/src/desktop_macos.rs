//! Window-targeted macOS input that never posts into the global HID stream.

use std::{
	mem,
	sync::{
		LazyLock,
		atomic::{AtomicIsize, Ordering},
	},
};

use objc2_app_kit::{NSEvent, NSEventModifierFlags, NSEventType};
use objc2_core_graphics::{CGEvent, CGEventField, CGEventFlags, CGScrollEventUnit};
use objc2_foundation::{NSPoint, NSProcessInfo, NSString};

use super::{
	CoreResult, DesktopError, Direction, ErrorCode, Key, MODIFIER_ALT, MODIFIER_CONTROL,
	MODIFIER_META, MODIFIER_SHIFT, MappedWindowAction, MouseButton, WindowSnapshot,
	execute_keypress_with, modifier_mask, scroll_steps,
};

#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
	fn AXIsProcessTrusted() -> bool;
}

type SetWindowLocation = unsafe extern "C" fn(Option<&CGEvent>, NSPoint);

static EVENT_NUMBER: AtomicIsize = AtomicIsize::new(1);
static SET_WINDOW_LOCATION: LazyLock<Option<SetWindowLocation>> = LazyLock::new(|| {
	// SAFETY: dlsym returns either null or the process-wide function pointer
	// for the exact CoreGraphics signature declared above.
	let symbol = unsafe { libc::dlsym(libc::RTLD_DEFAULT, c"CGEventSetWindowLocation".as_ptr()) };
	if symbol.is_null() {
		None
	} else {
		// SAFETY: The symbol name and ABI exactly match SetWindowLocation.
		Some(unsafe { mem::transmute::<*mut libc::c_void, SetWindowLocation>(symbol) })
	}
});

fn input_error(message: impl Into<String>) -> DesktopError {
	DesktopError::new(ErrorCode::InputFailed, message)
}

fn input_permission() -> CoreResult<()> {
	// SAFETY: AXIsProcessTrusted has no parameters and only reads current TCC
	// state; it never prompts or mutates application activation.
	if unsafe { AXIsProcessTrusted() } {
		Ok(())
	} else {
		Err(DesktopError::new(
			ErrorCode::PermissionDenied,
			"macOS Accessibility permission is required for window input",
		))
	}
}

fn set_window_location(event: &CGEvent, point: NSPoint) -> CoreResult<()> {
	let setter = (*SET_WINDOW_LOCATION).ok_or_else(|| {
		DesktopError::new(
			ErrorCode::BackendUnavailable,
			"this macOS release does not expose focus-preserving window event delivery",
		)
	})?;
	// SAFETY: `event` is retained for the call and `point` is passed by value.
	unsafe { setter(Some(event), point) };
	Ok(())
}

fn pid(snapshot: &WindowSnapshot) -> CoreResult<libc::pid_t> {
	i32::try_from(snapshot.pid)
		.map_err(|_| input_error(format!("window {} has an invalid process id", snapshot.rect.id)))
}

fn window_number(snapshot: &WindowSnapshot) -> CoreResult<isize> {
	isize::try_from(snapshot.rect.id)
		.map_err(|_| input_error(format!("window {} has an invalid id", snapshot.rect.id)))
}

fn appkit_flags(keys: &[Key], background_bypass: bool) -> NSEventModifierFlags {
	let mask = modifier_mask(keys);
	let mut flags = NSEventModifierFlags::empty();
	if mask & MODIFIER_CONTROL != 0 {
		flags |= NSEventModifierFlags::Control;
	}
	if mask & MODIFIER_SHIFT != 0 {
		flags |= NSEventModifierFlags::Shift;
	}
	if mask & MODIFIER_ALT != 0 {
		flags |= NSEventModifierFlags::Option;
	}
	if mask & MODIFIER_META != 0 || background_bypass {
		flags |= NSEventModifierFlags::Command;
	}
	flags
}

fn core_graphics_flags(flags: NSEventModifierFlags) -> CGEventFlags {
	let mut result = CGEventFlags::empty();
	if flags.contains(NSEventModifierFlags::Control) {
		result |= CGEventFlags::MaskControl;
	}
	if flags.contains(NSEventModifierFlags::Shift) {
		result |= CGEventFlags::MaskShift;
	}
	if flags.contains(NSEventModifierFlags::Option) {
		result |= CGEventFlags::MaskAlternate;
	}
	if flags.contains(NSEventModifierFlags::Command) {
		result |= CGEventFlags::MaskCommand;
	}
	result
}

fn local_point(snapshot: &WindowSnapshot, x: i32, y: i32) -> NSPoint {
	NSPoint { x: f64::from(x - snapshot.rect.x), y: f64::from(y - snapshot.rect.y) }
}

fn appkit_point(snapshot: &WindowSnapshot, x: i32, y: i32) -> NSPoint {
	let local = local_point(snapshot, x, y);
	NSPoint { x: local.x, y: f64::from(snapshot.rect.height) - local.y }
}

fn route_pointer_event(
	snapshot: &WindowSnapshot,
	event: &CGEvent,
	x: i32,
	y: i32,
	button: i64,
	flags: NSEventModifierFlags,
) -> CoreResult<()> {
	CGEvent::set_location(Some(event), NSPoint { x: f64::from(x), y: f64::from(y) });
	set_window_location(event, local_point(snapshot, x, y))?;
	CGEvent::set_integer_value_field(Some(event), CGEventField::MouseEventButtonNumber, button);
	// Subtype 3 plus the two public window fields bypass WindowServer's normal
	// focus-follows-mouse filter while keeping the real pointer untouched.
	CGEvent::set_integer_value_field(Some(event), CGEventField::MouseEventSubtype, 3);
	CGEvent::set_integer_value_field(
		Some(event),
		CGEventField::MouseEventWindowUnderMousePointer,
		i64::from(snapshot.rect.id),
	);
	CGEvent::set_integer_value_field(
		Some(event),
		CGEventField::MouseEventWindowUnderMousePointerThatCanHandleThisEvent,
		i64::from(snapshot.rect.id),
	);
	CGEvent::set_flags(Some(event), core_graphics_flags(flags));
	CGEvent::post_to_pid(pid(snapshot)?, Some(event));
	Ok(())
}

fn post_mouse(
	snapshot: &WindowSnapshot,
	event_type: NSEventType,
	x: i32,
	y: i32,
	button: i64,
	click_count: isize,
	modifiers: &[Key],
) -> CoreResult<()> {
	// The Command bit is a WindowServer dispatch bypass when the receiving app
	// is inactive. It does not activate or front the application.
	let flags = appkit_flags(modifiers, !snapshot.rect.focused);
	let event = NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
		event_type,
		appkit_point(snapshot, x, y),
		flags,
		NSProcessInfo::processInfo().systemUptime(),
		window_number(snapshot)?,
		None,
		EVENT_NUMBER.fetch_add(1, Ordering::Relaxed),
		click_count,
		0.0,
	)
	.ok_or_else(|| input_error("failed to create a targeted macOS mouse event"))?;
	let event = event
		.CGEvent()
		.ok_or_else(|| input_error("failed to convert the targeted NSEvent to CGEvent"))?;
	route_pointer_event(snapshot, &event, x, y, button, flags)
}

const fn mouse_types(button: MouseButton) -> (NSEventType, NSEventType, i64) {
	match button {
		MouseButton::Left => (NSEventType::LeftMouseDown, NSEventType::LeftMouseUp, 0),
		MouseButton::Right => (NSEventType::RightMouseDown, NSEventType::RightMouseUp, 1),
		MouseButton::Wheel => (NSEventType::OtherMouseDown, NSEventType::OtherMouseUp, 2),
		MouseButton::Back => (NSEventType::OtherMouseDown, NSEventType::OtherMouseUp, 3),
		MouseButton::Forward => (NSEventType::OtherMouseDown, NSEventType::OtherMouseUp, 4),
	}
}

fn click(
	snapshot: &WindowSnapshot,
	x: i32,
	y: i32,
	button: MouseButton,
	count: u8,
	modifiers: &[Key],
) -> CoreResult<()> {
	let (down, up, number) = mouse_types(button);
	for click_count in 1..=isize::from(count) {
		post_mouse(snapshot, down, x, y, number, click_count, modifiers)?;
		post_mouse(snapshot, up, x, y, number, click_count, modifiers)?;
	}
	Ok(())
}

fn drag(snapshot: &WindowSnapshot, path: &[(i32, i32)], modifiers: &[Key]) -> CoreResult<()> {
	let (x, y) = path[0];
	post_mouse(snapshot, NSEventType::LeftMouseDown, x, y, 0, 1, modifiers)?;
	for &(x, y) in &path[1..] {
		post_mouse(snapshot, NSEventType::LeftMouseDragged, x, y, 0, 1, modifiers)?;
	}
	let (x, y) = *path.last().expect("validated drag path");
	post_mouse(snapshot, NSEventType::LeftMouseUp, x, y, 0, 1, modifiers)
}

fn move_pointer(snapshot: &WindowSnapshot, x: i32, y: i32, modifiers: &[Key]) -> CoreResult<()> {
	post_mouse(snapshot, NSEventType::MouseMoved, x, y, 0, 0, modifiers)
}

fn scroll(
	snapshot: &WindowSnapshot,
	x: i32,
	y: i32,
	scroll_x: i32,
	scroll_y: i32,
	modifiers: &[Key],
) -> CoreResult<()> {
	let horizontal = scroll_steps(scroll_x);
	let vertical = scroll_steps(scroll_y);
	if horizontal == 0 && vertical == 0 {
		return Ok(());
	}
	let event =
		CGEvent::new_scroll_wheel_event2(None, CGScrollEventUnit::Line, 2, -vertical, -horizontal, 0)
			.ok_or_else(|| input_error("failed to create a targeted macOS scroll event"))?;
	let flags = appkit_flags(modifiers, false);
	// Field 51 is NSEvent's windowNumber; the public window-under-pointer
	// fields and private local location complete process-local routing.
	CGEvent::set_integer_value_field(Some(&event), CGEventField(51), i64::from(snapshot.rect.id));
	route_pointer_event(snapshot, &event, x, y, 0, flags)
}

const fn modifier_flag(key: Key) -> Option<NSEventModifierFlags> {
	match key {
		Key::Control => Some(NSEventModifierFlags::Control),
		Key::Shift => Some(NSEventModifierFlags::Shift),
		Key::Alt => Some(NSEventModifierFlags::Option),
		Key::Meta => Some(NSEventModifierFlags::Command),
		_ => None,
	}
}

fn key_characters(key: Key) -> String {
	match key {
		Key::Unicode(character) => character.to_string(),
		Key::Return => "\r".to_string(),
		Key::Tab => "\t".to_string(),
		Key::Space => " ".to_string(),
		Key::Backspace => "\u{8}".to_string(),
		_ => String::new(),
	}
}

fn post_key_event(
	snapshot: &WindowSnapshot,
	event_type: NSEventType,
	key: Key,
	flags: NSEventModifierFlags,
) -> CoreResult<()> {
	let keycode = u16::try_from(key)
		.map_err(|()| input_error(format!("{key:?} has no macOS virtual keycode")))?;
	let characters = NSString::from_str(&key_characters(key));
	let event = NSEvent::keyEventWithType_location_modifierFlags_timestamp_windowNumber_context_characters_charactersIgnoringModifiers_isARepeat_keyCode(
		event_type,
		NSPoint { x: 0.0, y: 0.0 },
		flags,
		NSProcessInfo::processInfo().systemUptime(),
		window_number(snapshot)?,
		None,
		&characters,
		&characters,
		false,
		keycode,
	)
	.ok_or_else(|| input_error("failed to create a targeted macOS key event"))?;
	let event = event
		.CGEvent()
		.ok_or_else(|| input_error("failed to convert the targeted key NSEvent to CGEvent"))?;
	CGEvent::set_integer_value_field(Some(&event), CGEventField(51), i64::from(snapshot.rect.id));
	CGEvent::set_flags(Some(&event), core_graphics_flags(flags));
	CGEvent::post_to_pid(pid(snapshot)?, Some(&event));
	Ok(())
}

fn keypress(snapshot: &WindowSnapshot, keys: &[Key]) -> CoreResult<()> {
	let mut flags = NSEventModifierFlags::empty();
	execute_keypress_with(keys, |key, direction| {
		if let Some(flag) = modifier_flag(key) {
			match direction {
				Direction::Press => {
					flags.insert(flag);
					post_key_event(snapshot, NSEventType::FlagsChanged, key, flags)
				},
				Direction::Release => {
					flags.remove(flag);
					post_key_event(snapshot, NSEventType::FlagsChanged, key, flags)
				},
				Direction::Click => {
					flags.insert(flag);
					post_key_event(snapshot, NSEventType::FlagsChanged, key, flags)?;
					flags.remove(flag);
					post_key_event(snapshot, NSEventType::FlagsChanged, key, flags)
				},
			}
		} else {
			match direction {
				Direction::Press => post_key_event(snapshot, NSEventType::KeyDown, key, flags),
				Direction::Release => post_key_event(snapshot, NSEventType::KeyUp, key, flags),
				Direction::Click => {
					post_key_event(snapshot, NSEventType::KeyDown, key, flags)?;
					post_key_event(snapshot, NSEventType::KeyUp, key, flags)
				},
			}
		}
	})
}

fn type_text(snapshot: &WindowSnapshot, text: &str) -> CoreResult<()> {
	for character in text.chars() {
		match character {
			'\n' | '\r' => keypress(snapshot, &[Key::Return])?,
			'\t' => keypress(snapshot, &[Key::Tab])?,
			_ => {
				let key = Key::Unicode(character);
				post_key_event(snapshot, NSEventType::KeyDown, key, NSEventModifierFlags::empty())?;
				post_key_event(snapshot, NSEventType::KeyUp, key, NSEventModifierFlags::empty())?;
			},
		}
	}
	Ok(())
}

/// Deliver one action directly to a window process without moving the real
/// pointer, posting to the global HID stream, or activating the application.
pub(super) fn execute(snapshot: &WindowSnapshot, action: MappedWindowAction) -> CoreResult<()> {
	input_permission()?;
	match action {
		MappedWindowAction::Click { x, y, button, count, modifiers } => {
			click(snapshot, x, y, button, count, &modifiers)
		},
		MappedWindowAction::Drag { path, modifiers } => drag(snapshot, &path, &modifiers),
		MappedWindowAction::Keypress { keys } => keypress(snapshot, &keys),
		MappedWindowAction::Move { x, y, modifiers } => move_pointer(snapshot, x, y, &modifiers),
		MappedWindowAction::Scroll { x, y, scroll_x, scroll_y, modifiers } => {
			scroll(snapshot, x, y, scroll_x, scroll_y, &modifiers)
		},
		MappedWindowAction::Type { text } => type_text(snapshot, &text),
	}
}
