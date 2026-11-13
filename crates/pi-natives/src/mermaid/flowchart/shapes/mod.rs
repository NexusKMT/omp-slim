//! Node-shape sizing, rendering, and edge attachment points.

use crate::mermaid::{
	canvas::{Canvas, DrawingCoord},
	flowchart::{Dir, NodeShape},
};

pub mod circle;
pub mod corners;
pub mod diamond;
pub mod hexagon;
pub mod rectangle;
pub mod rounded;
pub mod special;
pub mod stadium;
pub mod state;

use circle::Circle;
use diamond::Diamond;
use hexagon::Hexagon;
use rectangle::Rectangle;
use rounded::Rounded;
use special::{Asymmetric, Cylinder, DoubleCircle, Subroutine, Trapezoid, TrapezoidAlt};
use stadium::Stadium;
use state::{StateEnd, StateStart};

/// Bounds reserved for a shape's visible label.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LabelArea {
	/// Left edge relative to the shape canvas.
	pub x:      i32,
	/// Top edge relative to the shape canvas.
	pub y:      i32,
	/// Widest label line in terminal columns.
	pub width:  i32,
	/// Number of label lines.
	pub height: i32,
}

/// Canvas and logical-grid dimensions calculated for one shape.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ShapeDimensions {
	/// Total canvas width, including borders.
	pub width:        i32,
	/// Total canvas height, including borders.
	pub height:       i32,
	/// Region occupied by the label.
	pub label_area:   LabelArea,
	/// Widths of the left, center, and right logical-grid columns.
	pub grid_columns: [i32; 3],
	/// Heights of the top, middle, and bottom logical-grid rows.
	pub grid_rows:    [i32; 3],
}

/// Display options used for shape sizing and rendering.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ShapeRenderOptions {
	/// Select plain ASCII rather than Unicode box-drawing glyphs.
	pub use_ascii: bool,
	/// Blank columns and rows placed around the label.
	pub padding:   i32,
}

/// Pluggable sizing, drawing, and edge-attachment behavior for a node shape.
pub trait ShapeRenderer {
	/// Calculate the shape dimensions needed for `label`.
	fn dimensions(&self, label: &str, opts: &ShapeRenderOptions) -> ShapeDimensions;
	/// Draw `label` into a canvas with the precomputed dimensions.
	fn render(&self, label: &str, dims: &ShapeDimensions, opts: &ShapeRenderOptions) -> Canvas;
	/// Locate the shape boundary in `dir` relative to `base`.
	fn attachment_point(&self, dir: Dir, dims: &ShapeDimensions, base: DrawingCoord)
	-> DrawingCoord;
}

static RECTANGLE: Rectangle = Rectangle;
static ROUNDED: Rounded = Rounded;
static DIAMOND: Diamond = Diamond;
static STADIUM: Stadium = Stadium;
static CIRCLE: Circle = Circle;
static SUBROUTINE: Subroutine = Subroutine;
static DOUBLE_CIRCLE: DoubleCircle = DoubleCircle;
static HEXAGON: Hexagon = Hexagon;
static CYLINDER: Cylinder = Cylinder;
static ASYMMETRIC: Asymmetric = Asymmetric;
static TRAPEZOID: Trapezoid = Trapezoid;
static TRAPEZOID_ALT: TrapezoidAlt = TrapezoidAlt;
static STATE_START: StateStart = StateStart;
static STATE_END: StateEnd = StateEnd;

/// Return the renderer registered for a node shape.
pub fn renderer(shape: NodeShape) -> &'static dyn ShapeRenderer {
	match shape {
		NodeShape::Rectangle => &RECTANGLE,
		NodeShape::Rounded => &ROUNDED,
		NodeShape::Diamond => &DIAMOND,
		NodeShape::Stadium => &STADIUM,
		NodeShape::Circle => &CIRCLE,
		NodeShape::Subroutine => &SUBROUTINE,
		NodeShape::DoubleCircle => &DOUBLE_CIRCLE,
		NodeShape::Hexagon => &HEXAGON,
		NodeShape::Cylinder => &CYLINDER,
		NodeShape::Asymmetric => &ASYMMETRIC,
		NodeShape::Trapezoid => &TRAPEZOID,
		NodeShape::TrapezoidAlt => &TRAPEZOID_ALT,
		NodeShape::StateStart => &STATE_START,
		NodeShape::StateEnd => &STATE_END,
	}
}

/// Calculate dimensions for a shape and label.
pub fn shape_dimensions(
	shape: NodeShape,
	label: &str,
	opts: &ShapeRenderOptions,
) -> ShapeDimensions {
	renderer(shape).dimensions(label, opts)
}

/// Render a shape using dimensions calculated for the same label and options.
pub fn render_shape(
	shape: NodeShape,
	label: &str,
	dims: &ShapeDimensions,
	opts: &ShapeRenderOptions,
) -> Canvas {
	renderer(shape).render(label, dims, opts)
}

/// Calculate an edge attachment point on a shape boundary.
pub fn shape_attachment_point(
	shape: NodeShape,
	dir: Dir,
	dims: &ShapeDimensions,
	base: DrawingCoord,
) -> DrawingCoord {
	renderer(shape).attachment_point(dir, dims, base)
}


