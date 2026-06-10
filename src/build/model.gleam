import build/actors/agent
import build/actors/chat
import build/actors/preview
import build/actors/project
import build/actors/settings
import build/actors/webcontainer
import build/runtime/managed

pub type Model {
  Model(
    managed: Bool,
    settings: settings.State,
    chat: chat.State,
    project: project.State,
    agent: agent.State,
    preview: preview.State,
    webcontainer: webcontainer.State,
  )
}

pub fn init() -> Model {
  // Read once at boot: the sign-in gate registers the managed-auth bridge
  // before main() starts the runtime, and the mode never changes mid-session.
  let managed = managed.is_managed_auth()
  Model(
    managed: managed,
    settings: case managed {
      // Managed users never configure providers; don't open the modal on boot.
      True -> settings.State(..settings.init(), settings_open: False)
      False -> settings.init()
    },
    chat: chat.init(),
    project: project.init(),
    agent: agent.init(),
    preview: preview.init(),
    webcontainer: webcontainer.init(),
  )
}
