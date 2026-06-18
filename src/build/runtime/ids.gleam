//// Request id + clock FFI. Ids must be unique per dispatch so stale agent
//// responses (canceled or superseded requests) can be discarded by id match.

@external(javascript, "../../gleam-externals/ids.mjs", "newRequestId")
pub fn new_request_id() -> String

@external(javascript, "../../gleam-externals/ids.mjs", "nowMs")
pub fn now_ms() -> Int
