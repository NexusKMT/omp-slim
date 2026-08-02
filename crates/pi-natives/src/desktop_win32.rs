//! Window-targeted Win32 input using direct messages, never global SendInput.

use std::ffi::c_void;

use windows_sys::Win32::{
	Foundation::{GetLastError, HWND, LPARAM, POINT, WPARAM},
	Graphics::Gdi::ScreenToClient,
	UI::{
		Input::KeyboardAndMouse::{
			MAPVK_VK_TO_VSC, MapVirtualKeyW, VK_BACK, VK_CAPITAL, VK_CONTROL, VK_DELETE, VK_DOWN,
			VK_END, VK_ESCAPE, VK_F1, VK_F2, VK_F3, VK_F4, VK_F5, VK_F6, VK_F7, VK_F8, VK_F9, VK_F10,
			VK_F11, VK_F12, VK_F13, VK_F14, VK_F15, VK_F16, VK_F17, VK_F18, VK_F19, VK_F20, VK_F21,
			VK_F22, VK_F23, VK_F24, VK_HOME, VK_INSERT, VK_LEFT, VK_LWIN, VK_MENU, VK_NEXT,
			VK_NUMLOCK, VK_PRIOR, VK_RETURN, VK_RIGHT, VK_SHIFT, VK_SNAPSHOT, VK_SPACE, VK_TAB, VK_UP,
			VkKeyScanW,
		},
		WindowsAndMessaging::{
			IsWindow, PostMessageW, WM_CHAR, WM_KEYDOWN, WM_KEYUP, WM_LBUTTONDBLCLK, WM_LBUTTONDOWN,
			WM_LBUTTONUP, WM_MBUTTONDBLCLK, WM_MBUTTONDOWN, WM_MBUTTONUP, WM_MOUSEHWHEEL,
			WM_MOUSEMOVE, WM_MOUSEWHEEL, WM_RBUTTONDBLCLK, WM_RBUTTONDOWN, WM_RBUTTONUP,
			WM_SYSKEYDOWN, WM_SYSKEYUP, WM_XBUTTONDBLCLK, WM_XBUTTONDOWN, WM_XBUTTONUP, XBUTTON1,
			XBUTTON2,
		},
	},
};

use super::{
	CoreResult, DesktopError, Direction, ErrorCode, Key, MappedWindowAction, MouseButton,
	WindowSnapshot, execute_keypress_with, scroll_steps,
};

const MK_LBUTTON: usize = 0x0001;
const MK_RBUTTON: usize = 0x0002;
const MK_SHIFT: usize = 0x0004;
const MK_CONTROL: usize = 0x0008;
const MK_MBUTTON: usize = 0x0010;
const MK_XBUTTON1: usize = 0x0020;
const MK_XBUTTON2: usize = 0x0040;
const WHEEL_DELTA: i32 = 120;

fn input_error(message: impl Into<String>) -> DesktopError {
	DesktopError::new(ErrorCode::InputFailed, message)
}

fn hwnd(snapshot: &WindowSnapshot) -> CoreResult<HWND> {
	let address = usize::try_from(snapshot.rect.id)
		.map_err(|_| input_error(format!("window {} has an invalid id", snapshot.rect.id)))?;
	let hwnd = std::ptr::with_exposed_provenance_mut::<c_void>(address);
	// SAFETY: IsWindow validates the opaque handle before any message is posted.
	if unsafe { IsWindow(hwnd) } == 0 {
		return Err(DesktopError::new(
			ErrorCode::LayoutChanged,
			format!("target window `{}` is no longer present", snapshot.rect.id),
		));
	}
	Ok(hwnd)
}

fn post(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> CoreResult<()> {
	// SAFETY: `hwnd` was validated and PostMessageW copies these scalar values
	// into the target thread queue without retaining any borrowed memory.
	if unsafe { PostMessageW(hwnd, message, wparam, lparam) } != 0 {
		Ok(())
	} else {
		// SAFETY: GetLastError has no preconditions and is read immediately after
		// the failed Win32 call on the same thread.
		let code = unsafe { GetLastError() };
		Err(input_error(format!("PostMessageW failed with Win32 error {code}")))
	}
}

fn packed_point(x: i32, y: i32) -> CoreResult<LPARAM> {
	let x =
		i16::try_from(x).map_err(|_| input_error(format!("window x coordinate {x} exceeds i16")))?;
	let y =
		i16::try_from(y).map_err(|_| input_error(format!("window y coordinate {y} exceeds i16")))?;
	let low = u32::from(u16::from_ne_bytes(x.to_ne_bytes()));
	let high = u32::from(u16::from_ne_bytes(y.to_ne_bytes())) << 16;
	Ok(isize::try_from(i32::from_ne_bytes((low | high).to_ne_bytes()))
		.expect("i32 always fits Win32 LPARAM"))
}

fn client_point(hwnd: HWND, x: i32, y: i32) -> CoreResult<LPARAM> {
	let mut point = POINT { x, y };
	// SAFETY: point is writable for the duration of the call and hwnd is valid.
	if unsafe { ScreenToClient(hwnd, &mut point) } == 0 {
		return Err(input_error("ScreenToClient failed for the target window"));
	}
	packed_point(point.x, point.y)
}

fn mouse_flags(modifiers: &[Key]) -> usize {
	modifiers.iter().fold(0, |flags, key| {
		flags
			| match key {
				Key::Control => MK_CONTROL,
				Key::Shift => MK_SHIFT,
				_ => 0,
			}
	})
}

fn mouse_messages(button: MouseButton) -> (u32, u32, u32, usize, usize) {
	match button {
		MouseButton::Left => (WM_LBUTTONDOWN, WM_LBUTTONUP, WM_LBUTTONDBLCLK, MK_LBUTTON, 0),
		MouseButton::Right => (WM_RBUTTONDOWN, WM_RBUTTONUP, WM_RBUTTONDBLCLK, MK_RBUTTON, 0),
		MouseButton::Wheel => (WM_MBUTTONDOWN, WM_MBUTTONUP, WM_MBUTTONDBLCLK, MK_MBUTTON, 0),
		MouseButton::Back => {
			(WM_XBUTTONDOWN, WM_XBUTTONUP, WM_XBUTTONDBLCLK, MK_XBUTTON1, usize::from(XBUTTON1) << 16)
		},
		MouseButton::Forward => {
			(WM_XBUTTONDOWN, WM_XBUTTONUP, WM_XBUTTONDBLCLK, MK_XBUTTON2, usize::from(XBUTTON2) << 16)
		},
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
	let hwnd = hwnd(snapshot)?;
	let point = client_point(hwnd, x, y)?;
	let (down, up, double, button_flag, button_data) = mouse_messages(button);
	let flags = mouse_flags(modifiers);
	for index in 0..count {
		let message = if index == 1 { double } else { down };
		post(hwnd, message, button_data | flags | button_flag, point)?;
		post(hwnd, up, button_data | flags, point)?;
	}
	Ok(())
}

fn move_pointer(snapshot: &WindowSnapshot, x: i32, y: i32, flags: usize) -> CoreResult<()> {
	let hwnd = hwnd(snapshot)?;
	post(hwnd, WM_MOUSEMOVE, flags, client_point(hwnd, x, y)?)
}

fn drag(snapshot: &WindowSnapshot, path: &[(i32, i32)], modifiers: &[Key]) -> CoreResult<()> {
	let flags = mouse_flags(modifiers);
	let (x, y) = path[0];
	move_pointer(snapshot, x, y, flags)?;
	let hwnd = hwnd(snapshot)?;
	post(hwnd, WM_LBUTTONDOWN, flags | MK_LBUTTON, client_point(hwnd, x, y)?)?;
	for &(x, y) in &path[1..] {
		post(hwnd, WM_MOUSEMOVE, flags | MK_LBUTTON, client_point(hwnd, x, y)?)?;
	}
	let (x, y) = *path.last().expect("validated drag path");
	post(hwnd, WM_LBUTTONUP, flags, client_point(hwnd, x, y)?)
}

fn wheel_wparam(delta: i32, flags: usize) -> CoreResult<WPARAM> {
	let delta = i16::try_from(delta)
		.map_err(|_| input_error(format!("scroll delta {delta} exceeds Win32 message range")))?;
	Ok(flags | (usize::from(u16::from_ne_bytes(delta.to_ne_bytes())) << 16))
}

fn scroll(
	snapshot: &WindowSnapshot,
	x: i32,
	y: i32,
	scroll_x: i32,
	scroll_y: i32,
	modifiers: &[Key],
) -> CoreResult<()> {
	let hwnd = hwnd(snapshot)?;
	let location = packed_point(x, y)?;
	let flags = mouse_flags(modifiers);
	let horizontal = scroll_steps(scroll_x)
		.checked_mul(WHEEL_DELTA)
		.ok_or_else(|| input_error("horizontal scroll delta overflow"))?;
	let vertical = scroll_steps(scroll_y)
		.checked_mul(-WHEEL_DELTA)
		.ok_or_else(|| input_error("vertical scroll delta overflow"))?;
	if horizontal != 0 {
		post(hwnd, WM_MOUSEHWHEEL, wheel_wparam(horizontal, flags)?, location)?;
	}
	if vertical != 0 {
		post(hwnd, WM_MOUSEWHEEL, wheel_wparam(vertical, flags)?, location)?;
	}
	Ok(())
}

fn virtual_key(key: Key) -> CoreResult<(u16, u8)> {
	let result = match key {
		Key::Control => (VK_CONTROL, 0),
		Key::Shift => (VK_SHIFT, 0),
		Key::Alt => (VK_MENU, 0),
		Key::Meta => (VK_LWIN, 0),
		Key::Return => (VK_RETURN, 0),
		Key::Escape => (VK_ESCAPE, 0),
		Key::Tab => (VK_TAB, 0),
		Key::Space => (VK_SPACE, 0),
		Key::Backspace => (VK_BACK, 0),
		Key::Delete => (VK_DELETE, 0),
		Key::Insert => (VK_INSERT, 0),
		Key::Home => (VK_HOME, 0),
		Key::End => (VK_END, 0),
		Key::PageUp => (VK_PRIOR, 0),
		Key::PageDown => (VK_NEXT, 0),
		Key::UpArrow => (VK_UP, 0),
		Key::DownArrow => (VK_DOWN, 0),
		Key::LeftArrow => (VK_LEFT, 0),
		Key::RightArrow => (VK_RIGHT, 0),
		Key::CapsLock => (VK_CAPITAL, 0),
		Key::Numlock => (VK_NUMLOCK, 0),
		Key::PrintScr => (VK_SNAPSHOT, 0),
		Key::F1 => (VK_F1, 0),
		Key::F2 => (VK_F2, 0),
		Key::F3 => (VK_F3, 0),
		Key::F4 => (VK_F4, 0),
		Key::F5 => (VK_F5, 0),
		Key::F6 => (VK_F6, 0),
		Key::F7 => (VK_F7, 0),
		Key::F8 => (VK_F8, 0),
		Key::F9 => (VK_F9, 0),
		Key::F10 => (VK_F10, 0),
		Key::F11 => (VK_F11, 0),
		Key::F12 => (VK_F12, 0),
		Key::F13 => (VK_F13, 0),
		Key::F14 => (VK_F14, 0),
		Key::F15 => (VK_F15, 0),
		Key::F16 => (VK_F16, 0),
		Key::F17 => (VK_F17, 0),
		Key::F18 => (VK_F18, 0),
		Key::F19 => (VK_F19, 0),
		Key::F20 => (VK_F20, 0),
		Key::F21 => (VK_F21, 0),
		Key::F22 => (VK_F22, 0),
		Key::F23 => (VK_F23, 0),
		Key::F24 => (VK_F24, 0),
		Key::Unicode(character) => {
			let mut units = [0; 2];
			let encoded = character.encode_utf16(&mut units);
			if encoded.len() != 1 {
				return Err(input_error(format!(
					"{character:?} cannot be represented as a Win32 virtual key"
				)));
			}
			// SAFETY: VkKeyScanW accepts one UTF-16 code unit and reads the
			// current thread keyboard layout without changing global key state.
			let mapped = unsafe { VkKeyScanW(units[0]) };
			if mapped == -1 {
				return Err(input_error(format!(
					"{character:?} is not present in the active Win32 keyboard layout"
				)));
			}
			let bytes = mapped.to_ne_bytes();
			(u16::from(bytes[0]), bytes[1])
		},
		_ => return Err(input_error(format!("{key:?} has no Win32 virtual key"))),
	};
	Ok(result)
}

fn is_extended_key(vk: u16) -> bool {
	matches!(
		vk,
		VK_INSERT
			| VK_DELETE
			| VK_HOME
			| VK_END
			| VK_PRIOR
			| VK_NEXT
			| VK_LEFT
			| VK_RIGHT
			| VK_UP
			| VK_DOWN
	)
}

struct KeyEmitter {
	hwnd:      HWND,
	alt_depth: u8,
}

impl KeyEmitter {
	fn message_lparam(&self, vk: u16, release: bool) -> LPARAM {
		// SAFETY: MapVirtualKeyW is a pure lookup for a scalar virtual key.
		let scan = unsafe { MapVirtualKeyW(u32::from(vk), MAPVK_VK_TO_VSC) } & 0xff;
		let mut bits = 1u32 | (scan << 16);
		if is_extended_key(vk) {
			bits |= 1 << 24;
		}
		if self.alt_depth > 0 || vk == VK_MENU {
			bits |= 1 << 29;
		}
		if release {
			bits |= (1 << 30) | (1 << 31);
		}
		isize::try_from(i32::from_ne_bytes(bits.to_ne_bytes())).expect("i32 always fits Win32 LPARAM")
	}

	fn transition(&mut self, vk: u16, direction: Direction) -> CoreResult<()> {
		if matches!(direction, Direction::Press | Direction::Click) {
			let sys = self.alt_depth > 0 || vk == VK_MENU;
			post(
				self.hwnd,
				if sys { WM_SYSKEYDOWN } else { WM_KEYDOWN },
				usize::from(vk),
				self.message_lparam(vk, false),
			)?;
			if vk == VK_MENU {
				self.alt_depth = self.alt_depth.saturating_add(1);
			}
		}
		if matches!(direction, Direction::Release | Direction::Click) {
			let sys = self.alt_depth > 0 || vk == VK_MENU;
			post(
				self.hwnd,
				if sys { WM_SYSKEYUP } else { WM_KEYUP },
				usize::from(vk),
				self.message_lparam(vk, true),
			)?;
			if vk == VK_MENU {
				self.alt_depth = self.alt_depth.saturating_sub(1);
			}
		}
		Ok(())
	}

	fn key(&mut self, key: Key, direction: Direction) -> CoreResult<()> {
		let (vk, implicit) = virtual_key(key)?;
		let mut implicit_keys = Vec::with_capacity(3);
		if implicit & 1 != 0 {
			implicit_keys.push(VK_SHIFT);
		}
		if implicit & 2 != 0 {
			implicit_keys.push(VK_CONTROL);
		}
		if implicit & 4 != 0 {
			implicit_keys.push(VK_MENU);
		}
		if matches!(direction, Direction::Press | Direction::Click) {
			for &modifier in &implicit_keys {
				self.transition(modifier, Direction::Press)?;
			}
		}
		self.transition(vk, direction)?;
		if matches!(direction, Direction::Release | Direction::Click) {
			for &modifier in implicit_keys.iter().rev() {
				self.transition(modifier, Direction::Release)?;
			}
		}
		Ok(())
	}
}

fn keypress(snapshot: &WindowSnapshot, keys: &[Key]) -> CoreResult<()> {
	let mut emitter = KeyEmitter { hwnd: hwnd(snapshot)?, alt_depth: 0 };
	execute_keypress_with(keys, |key, direction| emitter.key(key, direction))
}

fn type_text(snapshot: &WindowSnapshot, text: &str) -> CoreResult<()> {
	let hwnd = hwnd(snapshot)?;
	for character in text.chars() {
		let character = if character == '\n' { '\r' } else { character };
		let mut units = [0; 2];
		for &unit in character.encode_utf16(&mut units).iter() {
			post(hwnd, WM_CHAR, usize::from(unit), 1)?;
		}
	}
	Ok(())
}

/// Deliver one action to a window's message queue without moving the real
/// pointer, using SendInput, or changing the foreground window.
pub(super) fn execute(snapshot: &WindowSnapshot, action: MappedWindowAction) -> CoreResult<()> {
	match action {
		MappedWindowAction::Click { x, y, button, count, modifiers } => {
			click(snapshot, x, y, button, count, &modifiers)
		},
		MappedWindowAction::Drag { path, modifiers } => drag(snapshot, &path, &modifiers),
		MappedWindowAction::Keypress { keys } => keypress(snapshot, &keys),
		MappedWindowAction::Move { x, y, modifiers } => {
			move_pointer(snapshot, x, y, mouse_flags(&modifiers))
		},
		MappedWindowAction::Scroll { x, y, scroll_x, scroll_y, modifiers } => {
			scroll(snapshot, x, y, scroll_x, scroll_y, &modifiers)
		},
		MappedWindowAction::Type { text } => type_text(snapshot, &text),
	}
}
