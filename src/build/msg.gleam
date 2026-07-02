import build/actors/agent
import build/actors/chat
import build/actors/preview
import build/actors/project
import build/actors/publish
import build/actors/settings
import build/actors/webcontainer

pub type Msg {
  NoOp
  InitApp
  SaveSettings
  SaveProject(silent: Bool)
  NewProject
  NewProjectConfirmed
  SubmitPrompt(request_id: String, now: Int)
  BuildFromPlan(plan_summary: String, request_id: String, now: Int)
  ImproveSelectedElement(request_id: String, now: Int)
  CancelAgent
  ResetProject
  ExportZip
  ExportStory
  OpenProject(String)
  RemoveProject(String)
  RemoveProjectConfirmed(String)
  Settings(settings.Msg)
  Chat(chat.Msg)
  Project(project.Msg)
  Agent(agent.Msg)
  Preview(preview.Msg)
  WebContainer(webcontainer.Msg)
  Publish(publish.Msg)
}
