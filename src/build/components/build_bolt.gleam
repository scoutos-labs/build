import lustre/attribute.{attribute}
import lustre/element.{type Element}
import lustre/element/svg

/// hyper's bolt mark (geometry from docs/hyper-brandkit.md): two opposing
/// triangular strokes — create meets build. Amber is reserved for this mark
/// and the working-state surfaces that carry it; never decoration.
const upper_stroke = "M28.6133 18.5759C29.2167 17.7689 30.5 18.1957 30.5 19.2033V33.5842H19.4821C18.6194 33.5842 18.1264 32.5999 18.643 31.909L28.6133 18.5759Z"

const lower_stroke = "M32.3868 41.8892C31.7834 42.6962 30.5 42.2694 30.5 41.2618V26.881H41.518C42.3807 26.881 42.8737 27.8652 42.357 28.5561L32.3868 41.8892Z"

/// Bare amber bolt for inline working-state surfaces (thinking pill,
/// preview overlay). Tight viewBox crops to the strokes.
pub fn glyph(class: String) -> Element(msg) {
  svg.svg(
    [
      attribute.class(class),
      attribute("viewBox", "16 16 29 29"),
      attribute("fill", "none"),
      attribute("aria-hidden", "true"),
    ],
    [
      svg.path([attribute("d", upper_stroke), attribute("fill", "#FABA00")]),
      svg.path([attribute("d", lower_stroke), attribute("fill", "#FABA00")]),
    ],
  )
}

/// The full logo lockup — amber rounded square, white bolt — for the
/// wordmark (and mirrored by public/favicon.svg).
pub fn lockup(class: String) -> Element(msg) {
  svg.svg(
    [
      attribute.class(class),
      attribute("viewBox", "0 0 61 61"),
      attribute("fill", "none"),
      attribute("aria-hidden", "true"),
    ],
    [
      svg.rect([
        attribute("width", "61"),
        attribute("height", "61"),
        attribute("rx", "12"),
        attribute("fill", "#FABA00"),
      ]),
      svg.path([attribute("d", upper_stroke), attribute("fill", "#ffffff")]),
      svg.path([attribute("d", lower_stroke), attribute("fill", "#ffffff")]),
    ],
  )
}
