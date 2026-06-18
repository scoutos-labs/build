//// Managed-auth mode (Clerk + server-proxied OpenRouter). True when the
//// sign-in gate registered the auth bridge before the app booted; the legacy
//// bring-your-own-key flow stays available while this is False.

@external(javascript, "../../gleam-externals/managed.mjs", "isManagedAuth")
pub fn is_managed_auth() -> Bool
