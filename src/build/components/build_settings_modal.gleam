import build/actors/settings
import build/msg
import lustre/attribute
import lustre/element.{type Element}
import lustre/element/html
import lustre/event

pub fn view(state: settings.State, managed: Bool) -> Element(msg.Msg) {
  case state.settings_open, managed {
    False, _ -> html.text("")
    True, True -> account_panel(state)
    True, False ->
      html.div(
        [attribute.class("modalBackdrop"), attribute.role("presentation")],
        [
          html.div(
            [
              attribute.class("modal"),
              attribute.role("dialog"),
              attribute.aria_modal(True),
              attribute.aria_labelledby("settings-title"),
            ],
            [
              header(state),
              provider_field(state.provider),
              provider_specific_fields(state),
              model_field(state),
              html.div([attribute.class("modalActions")], [
                html.button(
                  [
                    attribute.type_("button"),
                    attribute.disabled(!can_save(state)),
                    event.on_click(msg.SaveSettings),
                  ],
                  [html.text("Save settings")],
                ),
              ]),
            ],
          ),
        ],
      )
  }
}

/// Managed mode: no providers, keys, or models — just plan, budget, sign out.
fn account_panel(state: settings.State) -> Element(msg.Msg) {
  html.div(
    [attribute.class("modalBackdrop"), attribute.role("presentation")],
    [
      html.div(
        [
          attribute.class("modal"),
          attribute.role("dialog"),
          attribute.aria_modal(True),
          attribute.aria_labelledby("settings-title"),
        ],
        [
          html.div([attribute.class("modalHeader")], [
            html.div([], [
              html.h2([attribute.id("settings-title")], [html.text("Account")]),
              html.p([], [html.text("Your plan and monthly build budget.")]),
            ]),
            html.button(
              [
                attribute.type_("button"),
                attribute.class("ghost iconButton"),
                attribute.aria_label("Close account panel"),
                event.on_click(msg.Settings(settings.SettingsClosed)),
              ],
              [html.text("×")],
            ),
          ]),
          html.label([], [
            html.text("Plan"),
            html.strong([], [
              html.text(case state.account_plan {
                "" -> "Loading..."
                plan -> plan
              }),
            ]),
          ]),
          html.label([], [
            html.text("Budget"),
            html.span([], [
              html.text(case state.account_budget {
                "" -> "Loading..."
                budget -> budget
              }),
            ]),
          ]),
          html.div([attribute.class("modalActions")], [
            html.button(
              [
                attribute.type_("button"),
                attribute.class("secondary"),
                event.on_click(msg.Settings(settings.SignOutRequested)),
              ],
              [html.text("Sign out")],
            ),
          ]),
        ],
      ),
    ],
  )
}

fn header(state: settings.State) {
  html.div([attribute.class("modalHeader")], [
    html.div([], [
      html.h2([attribute.id("settings-title")], [html.text("Model settings")]),
      html.p([], [html.text("Choose how Build connects to an LLM.")]),
    ]),
    html.button(
      [
        attribute.type_("button"),
        attribute.class("ghost iconButton"),
        attribute.aria_label("Close settings"),
        attribute.disabled(state.model == ""),
        event.on_click(msg.Settings(settings.SettingsClosed)),
      ],
      [html.text("×")],
    ),
  ])
}

fn provider_field(provider: settings.Provider) {
  html.label([], [
    html.text("Provider"),
    html.select(
      [
        attribute.value(settings.provider_to_string(provider)),
        event.on_change(fn(value) {
          msg.Settings(
            settings.ProviderChanged(settings.provider_from_string(value)),
          )
        }),
      ],
      [
        html.option([attribute.value("openrouter")], "OpenRouter"),
        html.option([attribute.value("ollama")], "Ollama local/cloud"),
      ],
    ),
  ])
}

fn provider_specific_fields(state: settings.State) {
  case state.provider {
    settings.Ollama ->
      html.label([], [
        html.text("Ollama URL"),
        html.input([
          attribute.value(state.ollama_url),
          attribute.placeholder("http://localhost:11434"),
          event.on_input(fn(value) {
            msg.Settings(settings.OllamaUrlChanged(value))
          }),
        ]),
        html.button(
          [
            attribute.type_("button"),
            attribute.class("secondary compact"),
            event.on_click(msg.Settings(settings.TestOllama)),
          ],
          [html.text("Test Ollama connection")],
        ),
        case state.connection_status {
          "" -> html.text("")
          _ ->
            html.small([attribute.class("status")], [
              html.text(state.connection_status),
            ])
        },
      ])
    settings.OpenRouter ->
      html.label([], [
        html.text("OpenRouter API key"),
        html.input([
          attribute.type_("password"),
          attribute.value(state.api_key),
          attribute.placeholder("sk-or-..."),
          event.on_input(fn(value) {
            msg.Settings(settings.ApiKeyChanged(value))
          }),
        ]),
      ])
  }
}

fn model_field(state: settings.State) {
  html.label([], [
    html.text("Model"),
    html.input([
      attribute.value(state.model),
      attribute.placeholder(case state.provider {
        settings.Ollama -> "glm-5:cloud"
        settings.OpenRouter -> "anthropic/claude-3.5-sonnet"
      }),
      event.on_input(fn(value) { msg.Settings(settings.ModelChanged(value)) }),
    ]),
  ])
}

fn can_save(state: settings.State) -> Bool {
  state.model != ""
  && case state.provider {
    settings.OpenRouter -> state.api_key != ""
    settings.Ollama -> True
  }
}
