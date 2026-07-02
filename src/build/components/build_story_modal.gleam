//// The Build Story view: an editorial, non-technical narrative of how the
//// current app came to be, derived live from chat history, the build log,
//// and BRAIN.md. Tinted by the app's own brand accent when one is recorded.

import build/actors/chat
import build/actors/project
import build/msg
import build/pure/build_log
import build/pure/story
import build/pure/templates
import gleam/int
import gleam/list
import gleam/string
import lustre/attribute
import lustre/element.{type Element}
import lustre/element/html
import lustre/event

pub fn view(
  open: Bool,
  title: String,
  messages: List(chat.Message),
  entries: List(build_log.Entry),
  files: List(templates.ProjectFile),
) -> Element(msg.Msg) {
  case open {
    False -> html.text("")
    True -> {
      let derived = story.from_project(title, messages, entries, files)
      html.div(
        [attribute.class("modalBackdrop"), attribute.role("presentation")],
        [
          html.div(
            [
              attribute.class("modal storyModal"),
              attribute.role("dialog"),
              attribute.aria_modal(True),
              attribute.aria_labelledby("story-title"),
              attribute.attribute(
                "style",
                "--story-accent: " <> story.accent(derived),
              ),
            ],
            [header(derived.title), body(derived)],
          ),
        ],
      )
    }
  }
}

fn header(title: String) {
  html.div([attribute.class("modalHeader storyHeader")], [
    html.div([], [
      html.p([attribute.class("storyKicker")], [html.text("A build story")]),
      html.h2([attribute.id("story-title")], [html.text(title)]),
    ]),
    html.div([attribute.class("storyHeaderActions")], [
      html.button(
        [
          attribute.type_("button"),
          attribute.class("secondary compact"),
          event.on_click(msg.ExportStory),
        ],
        [html.text("Export story")],
      ),
      html.button(
        [
          attribute.type_("button"),
          attribute.class("ghost iconButton"),
          attribute.aria_label("Close story"),
          event.on_click(msg.Project(project.StoryDialogClosed)),
        ],
        [html.text("×")],
      ),
    ]),
  ])
}

fn body(derived: story.Story) {
  html.div(
    [attribute.class("storyBody")],
    list.flatten([
      [origin_block(derived.origin)],
      [html.h3([], [html.text("How it took shape")])],
      chapters_block(derived.chapters),
      decisions_block(derived.decisions),
      brand_block(derived.brand),
    ]),
  )
}

fn origin_block(origin: String) {
  html.section(
    [attribute.class("storyOrigin")],
    text_paragraphs(origin),
  )
}

fn chapters_block(chapters: List(story.Chapter)) {
  case chapters {
    [] -> [
      html.p([attribute.class("storyEmpty")], [
        html.text("No build steps yet — the story starts with the first ask."),
      ]),
    ]
    _ -> list.index_map(chapters, chapter_block)
  }
}

fn chapter_block(chapter: story.Chapter, index: Int) {
  html.article([attribute.class("storyChapter")], [
    html.div([attribute.class("storyChapterRule")], [
      html.span([attribute.class("storyChapterNumber")], [
        html.text(int.to_string(index + 1)),
      ]),
    ]),
    html.blockquote([attribute.class("storyAsk")], [
      html.text("“" <> chapter.ask <> "”"),
    ]),
    html.div([attribute.class("storyOutcome")], text_paragraphs(chapter.outcome)),
    case chapter.areas {
      [] -> html.text("")
      areas ->
        html.div(
          [attribute.class("storyChips")],
          list.map(areas, fn(area) {
            html.span([attribute.class("storyChip")], [html.text(area)])
          }),
        )
    },
  ])
}

fn decisions_block(decisions: List(String)) {
  case decisions {
    [] -> []
    _ -> [
      html.h3([], [html.text("Decisions along the way")]),
      html.ul(
        [attribute.class("storyDecisions")],
        list.map(decisions, fn(decision) { html.li([], [html.text(decision)]) }),
      ),
    ]
  }
}

fn brand_block(brand: String) {
  case brand {
    "" -> []
    _ -> [
      html.h3([], [html.text("The brand")]),
      html.section([attribute.class("storyBrand")], text_paragraphs(brand)),
    ]
  }
}

fn text_paragraphs(text: String) -> List(Element(msg.Msg)) {
  text
  |> string.split("\n")
  |> list.map(string.trim)
  |> list.filter(fn(line) { line != "" })
  |> list.map(fn(line) { html.p([], [html.text(line)]) })
}
