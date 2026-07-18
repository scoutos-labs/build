import gleam/list

pub type Role {
  User
  Assistant
}

pub type Message {
  // `paths` are the files the agent touched in the turn that produced this
  // message (assistant turns with patches only; [] otherwise). Riding on the
  // message itself keeps chips correct across error bubbles and reloads —
  // no index correlation with the build log.
  Message(role: Role, content: String, paths: List(String))
}

pub type State {
  State(messages: List(Message), prompt: String, expanded_messages: List(Int))
}

pub type Msg {
  UserSentMessage(String)
  AssistantReplied(content: String, paths: List(String))
  AssistantError(String)
  PromptChanged(String)
  MessageToggled(Int)
  MessagesReplaced(List(Message))
  ChatCleared
}

pub fn init() -> State {
  State(messages: [], prompt: "", expanded_messages: [])
}

pub fn update(state: State, msg: Msg) -> State {
  case msg {
    UserSentMessage(content) ->
      State(..state, messages: list.append(state.messages, [Message(User, content, [])]), prompt: "")
    AssistantReplied(content, paths) ->
      State(..state, messages: list.append(state.messages, [Message(Assistant, content, paths)]))
    AssistantError(message) ->
      State(..state, messages: list.append(state.messages, [Message(Assistant, "Error: " <> message, [])]))
    PromptChanged(value) -> State(..state, prompt: value)
    MessageToggled(index) -> {
      let expanded = case list.contains(state.expanded_messages, index) {
        True -> list.filter(state.expanded_messages, fn(item) { item != index })
        False -> [index, ..state.expanded_messages]
      }
      State(..state, expanded_messages: expanded)
    }
    MessagesReplaced(messages) -> State(..state, messages: messages, expanded_messages: [])
    ChatCleared -> State(messages: [], prompt: state.prompt, expanded_messages: [])
  }
}
