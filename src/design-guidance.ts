export const anthropicBrandGuidelines = `Anthropic brand guide:
- Main colors: Dark #141413, Light #faf9f5, Mid Gray #b0aea5, Light Gray #e8e6dc.
- Accent colors: Orange #d97757, Blue #6a9bcc, Green #788c5d.
- Typography: headings use Poppins with Arial fallback; body text uses Lora with Georgia fallback.
- Use brand colors with restrained confidence, preserving readability and hierarchy.`

export const anthropicFrontendDesignSkill = `Frontend design skill:
- Build distinctive, production-grade interfaces with a clear aesthetic point of view.
- Avoid generic AI aesthetics: predictable SaaS layouts, purple gradients, nested cards, default fonts (Inter, Roboto, Arial), and cookie-cutter components.
- Make deliberate choices in typography, color, spacing, layout, motion, and visual details.
- Match implementation complexity to the aesthetic vision: maximal designs need rich details; minimal designs need precision.
- Use accessible, working code and preserve app functionality.
- Focus on: distinctive typography (pair a display font with a refined body), cohesive dominant color palettes with sharp accents, motion and micro-interactions, unexpected spatial composition (asymmetry, overlap, diagonal flow), atmospheric backgrounds and textures.
- Interpret the context and make unexpected choices. No two designs should feel the same. Vary themes, fonts, and aesthetics across generations.`

export const scoutBrandStyles = `Scout Studio observed brand styles from https://studio.scoutos.com:
- Overall register: restrained product UI, crisp, quiet, high-trust, monochrome-first.
- Font: GeistSans with GeistSans Fallback; use system sans fallback only after Geist.
- Base background: white / oklch(1 0 0); primary text around oklch(0.3211 0 0) or rgb(33 33 38).
- Secondary text: dark text at roughly 65% opacity.
- Primary controls: near-charcoal rgb(47 48 55) backgrounds with white text.
- Inputs/buttons: compact 13px text, 6px border radius, 6px 12px padding, subtle 1px ring shadows instead of heavy borders.
- Shadows: minimal layered rings and tiny elevation, e.g. 0 0 0 1px low-alpha black plus small 1-3px y shadow.
- App shell: pale gray left sidebar around 314px wide with a fine divider, white main canvas, sparse navigation, muted gray labels, and blue active/action accents.
- Home screen composition: large centered greeting block with dark heading and oversized muted-gray subheading, followed by a wide rounded prompt composer.
- Composer styling: 1px rainbow/blue-pink focus ring or gradient border, large radius around 16px, ample internal whitespace, subdued placeholder text, small icon row, and a quiet send button.
- Chat list: compact rows with 28-32px circular avatars, soft gradient placeholders, 15-16px gray labels, clipped long titles.
- Tool/banner surfaces: very light gray rounded rectangles, small integration icons, low-contrast utility copy.
- Layout: compact controls with generous surrounding whitespace; the interface feels airy without being decorative.
- Avoid decorative gradients except subtle avatar fills and fine focus rings; prefer precise spacing, crisp controls, and quiet contrast.`

export function designGuidancePrompt() {
  return `${anthropicFrontendDesignSkill}\n\n${anthropicBrandGuidelines}\n\n${scoutBrandStyles}`
}
