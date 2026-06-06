import build/actors/preview
import build/actors/settings
import build/effect
import build/runtime
import gleeunit

pub fn main() -> Nil {
  gleeunit.main()
}

pub fn runtime_interprets_settings_effect_test() {
  assert runtime.interpret(effect.Settings(settings.PersistSettings(
    provider: settings.OpenRouter,
    api_key: "key",
    ollama_url: "http://localhost:11434",
    scoutos_api_key: "",
    scoutos_base_url: "https://api.scoutos.com",
    model: "model",
  ))) == Nil
}

pub fn runtime_interprets_preview_effect_test() {
  assert runtime.interpret(effect.Preview(preview.PostInspectorMessage(preview.BuildInspectorEnable))) == Nil
}

pub fn runtime_interprets_effect_list_test() {
  assert runtime.interpret_all([
    effect.Settings(settings.TestOllamaConnection("http://localhost:11434")),
    effect.Preview(preview.PostInspectorMessage(preview.BuildInspectorDisable)),
  ]) == Nil
}
