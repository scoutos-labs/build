import build/actors/agent
import build/actors/preview
import build/actors/project
import build/actors/publish
import build/actors/settings
import build/actors/webcontainer
import build/pure/story
import build/pure/templates

pub type Effect {
  Settings(settings.Effect)
  Project(project.Effect)
  Agent(agent.Effect)
  Preview(preview.Effect)
  WebContainer(webcontainer.Effect)
  Publish(publish.Effect)
  ExportZip(files: List(templates.ProjectFile))
  ExportStoryHtml(story: story.Story)
  ConfirmNewProject
  ConfirmRemoveProject(id: String)
  ScrollMessagesToBottom
  FocusLayoutSegment
}
