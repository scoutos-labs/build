import { dispatchNewProjectConfirmed, dispatchRemoveProjectConfirmed } from './runtime_bridge.mjs'

let newProjectPending = false

export function confirmNewProject() {
  if (newProjectPending) return
  newProjectPending = true
  try {
    if (window.confirm('Start a new project? Unsaved changes are auto-saved first.')) {
      dispatchNewProjectConfirmed()
    }
  } finally {
    newProjectPending = false
  }
}

let removeProjectPending = false

export function confirmRemoveProject(id) {
  if (removeProjectPending) return
  removeProjectPending = true
  try {
    if (window.confirm('Delete this project? This cannot be undone.')) {
      dispatchRemoveProjectConfirmed(id)
    }
  } finally {
    removeProjectPending = false
  }
}
