import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import { compileSchema } from '../agreements/agreements.dto';
import { CompiledTerms, compiledTermsSchema } from './compiler.schema';

const SYSTEM_PROMPT = `You structure freelance project descriptions into milestone agreements.
Return ONLY JSON matching this shape:
{"total_amount": <integer minor units>, "currency": "NGN", "milestones": [{"title": string, "amount": <integer minor units>, "conditions": ["tests_pass"|"client_approval"|"evidence_submitted"], "verification": "client_approval"|"automated_test"|"manual_review"}], "required_approvals": ["payer","payee"], "dispute_terms": string}
Rules: milestone amounts MUST sum exactly to total_amount. Use 2-5 milestones. Amounts are integers in minor units (kobo). Never invent parties or dates.`;

@Injectable()
export class CompilerService {
  private readonly logger = new Logger(CompilerService.name);

  constructor(private readonly config: ConfigService) {}

  /**
   * Proposes terms. The output is labelled as AI-suggested and binds nobody:
   * both parties must approve before the agreement can be funded.
   */
  async compile(input: z.infer<typeof compileSchema>): Promise<{
    terms: CompiledTerms;
    source: 'anthropic' | 'openrouter' | 'heuristic';
    disclaimer: string;
  }> {
    const mode = this.config.get<string>('AI_MODE') ?? 'heuristic';
    let terms: CompiledTerms;
    let source: 'anthropic' | 'openrouter' | 'heuristic' = 'heuristic';

    const model =
      mode === 'anthropic' && this.config.get('ANTHROPIC_API_KEY')
        ? ('anthropic' as const)
        : mode === 'openrouter' && this.config.get('OPENROUTER_API_KEY')
          ? ('openrouter' as const)
          : null;

    if (model) {
      try {
        terms =
          model === 'anthropic'
            ? await this.compileWithAnthropic(input)
            : await this.compileWithOpenRouter(input);
        source = model;
      } catch (error) {
        // A model being slow, down or wrong must never break the flow: the
        // deterministic split is always a valid agreement.
        this.logger.warn(`AI compile failed, falling back: ${(error as Error).message}`);
        terms = this.compileHeuristically(input);
      }
    } else {
      terms = this.compileHeuristically(input);
    }

    return {
      terms,
      source,
      disclaimer: 'Suggested by AI, please review. Both parties must approve before funding.',
    };
  }

  /** The user prompt is identical whichever provider runs it. */
  private userPrompt(input: z.infer<typeof compileSchema>): string {
    return `Currency: ${input.currency}. Budget in minor units: ${
      input.budgetAmount ?? 'not stated, propose one'
    }.\n\nProject:\n${input.description}`;
  }

  /**
   * Models return prose around their JSON often enough that this has to be
   * tolerant — but the result is still schema-validated before it is trusted.
   */
  private parseAndValidate(text: string): CompiledTerms {
    const jsonText = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      throw new Error('Model did not return parseable JSON');
    }

    const result = compiledTermsSchema.safeParse(parsed);
    if (!result.success) {
      throw new BadRequestException({
        message: 'AI output rejected by schema validation',
        issues: result.error.issues.map((i) => i.message),
      });
    }
    return result.data;
  }

  /**
   * OpenRouter speaks the OpenAI chat format and fronts many models, including
   * Claude. Useful when billing should go through one account rather than each
   * provider separately.
   */
  private async compileWithOpenRouter(input: z.infer<typeof compileSchema>): Promise<CompiledTerms> {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.config.get<string>('OPENROUTER_API_KEY') ?? ''}`,
        // OpenRouter attributes usage to these; harmless but good manners.
        'HTTP-Referer': this.config.get<string>('PUBLIC_API_URL') ?? 'https://amana.local',
        'X-Title': 'Amana',
      },
      body: JSON.stringify({
        model: this.config.get<string>('OPENROUTER_MODEL') ?? 'anthropic/claude-sonnet-4.5',
        max_tokens: 1500,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: this.userPrompt(input) },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenRouter returned ${response.status}: ${(await response.text()).slice(0, 200)}`);
    }
    const json = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
      error?: { message?: string };
    };
    if (json.error) throw new Error(`OpenRouter: ${json.error.message}`);

    const text = json.choices?.[0]?.message?.content ?? '';
    if (!text) throw new Error('OpenRouter returned an empty completion');
    return this.parseAndValidate(text);
  }

  private async compileWithAnthropic(input: z.infer<typeof compileSchema>): Promise<CompiledTerms> {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.config.get<string>('ANTHROPIC_API_KEY') ?? '',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.config.get<string>('ANTHROPIC_MODEL') ?? 'claude-sonnet-5',
        max_tokens: 1500,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: this.userPrompt(input) }],
      }),
    });

    if (!response.ok) throw new Error(`Anthropic returned ${response.status}`);
    const json = (await response.json()) as { content: { type: string; text?: string }[] };
    const text = json.content.find((block) => block.type === 'text')?.text ?? '';
    // The backend rejects any AI output that does not match the schema or whose
    // milestone amounts do not sum to the total (PRD section 10).
    return this.parseAndValidate(text);
  }

  /**
   * Deterministic fallback so the demo never depends on a model being reachable.
   * Splits the budget across milestones inferred from the description.
   */
  private compileHeuristically(input: z.infer<typeof compileSchema>): CompiledTerms {
    const total = input.budgetAmount ?? 10_000_000; // ₦100,000 default
    const phrases = input.description
      .split(/[.;\n]|\band then\b|\bthen\b/i)
      .map((part) => part.trim())
      .filter((part) => part.length > 8)
      .slice(0, 4);

    const titles = phrases.length >= 2 ? phrases : ['First deliverable', 'Final delivery'];
    const share = Math.floor(total / titles.length);

    const milestones = titles.map((title, index) => {
      const mentionsTests = /test|ci|deploy|build/i.test(title);
      return {
        title: title.slice(0, 140).replace(/^\w/, (c) => c.toUpperCase()),
        // The last milestone absorbs the rounding remainder so the sum is exact.
        amount: index === titles.length - 1 ? total - share * (titles.length - 1) : share,
        conditions: mentionsTests
          ? (['tests_pass', 'client_approval'] as const)
          : (['client_approval'] as const),
        verification: mentionsTests ? ('automated_test' as const) : ('client_approval' as const),
      };
    });

    return compiledTermsSchema.parse({
      total_amount: total,
      currency: input.currency,
      milestones: milestones.map((m) => ({ ...m, conditions: [...m.conditions] })),
      required_approvals: ['payer', 'payee'],
      dispute_terms: 'Payout paused; admin reviews evidence from both parties',
    });
  }
}
