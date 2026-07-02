import { describe, expect, it } from 'vitest'
import { anthropicBrandGuidelines, anthropicFrontendDesignSkill, designGuidancePrompt, scoutBrandStyles } from './design-guidance'

describe('design guidance', () => {
  it('includes Anthropic brand colors and typography', () => {
    expect(anthropicBrandGuidelines).toContain('#141413')
    expect(anthropicBrandGuidelines).toContain('#faf9f5')
    expect(anthropicBrandGuidelines).toContain('Poppins')
    expect(anthropicBrandGuidelines).toContain('Lora')
  })

  it('includes frontend design anti-generic guidance', () => {
    expect(anthropicFrontendDesignSkill).toContain('distinctive')
    expect(anthropicFrontendDesignSkill).toContain('Avoid generic AI aesthetics')
  })

  it('includes expanded frontend design guidance', () => {
    // Expanded from 6-line to full skill: covers more categories
    expect(anthropicFrontendDesignSkill).toContain('Inter') // font anti-pattern
    expect(anthropicFrontendDesignSkill).toContain('typography')
    expect(anthropicFrontendDesignSkill).toContain('cohesive')
    expect(anthropicFrontendDesignSkill).toContain('motion')
    expect(anthropicFrontendDesignSkill).toContain('asymmetry')
    expect(anthropicFrontendDesignSkill).toContain('distinctive typography')
    expect(anthropicFrontendDesignSkill).toContain('No two designs should feel the same')
  })

  it('includes observed Scout Studio product styling', () => {
    expect(scoutBrandStyles).toContain('GeistSans')
    expect(scoutBrandStyles).toContain('rgb(47 48 55)')
    expect(scoutBrandStyles).toContain('6px')
    expect(scoutBrandStyles).toContain('left sidebar')
    expect(scoutBrandStyles).toContain('prompt composer')
  })

  it('combines all guidance into one prompt block', () => {
    const prompt = designGuidancePrompt()
    expect(prompt).toContain('Anthropic brand guide')
    expect(prompt).toContain('Frontend design skill')
    expect(prompt).toContain('Scout Studio observed brand styles')
  })
})
