import build/actors/agent
import build/actors/chat
import build/actors/interview
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
  Interview(interview.Msg)
  // The recap's "Build my app" button; id/now generated event-side like
  // SubmitPrompt so replays are idempotent.
  InterviewBuild(request_id: String, now: Int)
  Project(project.Msg)
  Agent(agent.Msg)
  Preview(preview.Msg)
  // Keyboard-driven layout change: same as LayoutModeSelected plus a
  // focus-follows-selection effect after re-render.
  LayoutModeKeyed(preview.LayoutMode)
  WebContainer(webcontainer.Msg)
  Publish(publish.Msg)
  // "Try to fix" on the chat's preview-error card; id/now generated
  // event-side like SubmitPrompt so replays are idempotent.
  FixPreviewError(request_id: String, now: Int)
  // An app idea typed on the pre-auth landing page, dispatched once right
  // after boot hydration settles (after ProjectReady). If the onboarding
  // interview just started it answers the first question; otherwise the
  // idea lands in the composer so it is never lost.
  LandingIdeaArrived(String)
}
