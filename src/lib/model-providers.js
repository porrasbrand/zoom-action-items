/**
 * model-providers.js - Unified interface for multiple LLM providers
 * Supports: Gemini (Google), Claude (Anthropic), GPT (OpenAI)
 */

import 'dotenv/config';

/**
 * Call a model with a prompt, routing to the correct SDK based on model ID prefix
 * @param {string} modelId - Model identifier (e.g., 'gemini-2.0-flash', 'claude-opus-4-6', 'gpt-5.4')
 * @param {string} prompt - The prompt to send
 * @param {object} options - Optional configuration
 * @returns {Promise<{text: string, tokensIn: number, tokensOut: number}>}
 */
export async function callModel(modelId, prompt, options = {}) {
  const temperature = options.temperature ?? 0.3;
  const maxTokens = options.maxTokens ?? 4096;

  // Add JSON instruction for non-Gemini models
  const jsonInstruction = '\n\nIMPORTANT: Return ONLY valid JSON, no markdown fences, no extra text.';

  if (modelId.startsWith('claude-')) {
    return await callClaude(modelId, prompt + jsonInstruction, { temperature, maxTokens });
  } else if (modelId.startsWith('gpt-')) {
    return await callOpenAI(modelId, prompt + jsonInstruction, { temperature, maxTokens });
  } else {
    // Default to Gemini (gemini-*)
    return await callGemini(modelId, prompt, { temperature, maxTokens });
  }
}

/**
 * Call Anthropic Claude model
 */
async function callClaude(modelId, prompt, options) {
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const response = await client.messages.create({
    model: modelId,
    max_tokens: options.maxTokens,
    temperature: options.temperature,
    messages: [{ role: 'user', content: prompt }]
  });

  return {
    text: response.content[0].text,
    tokensIn: response.usage.input_tokens,
    tokensOut: response.usage.output_tokens
  };
}

/**
 * Call OpenAI GPT model
 */
async function callOpenAI(modelId, prompt, options) {
  const OpenAI = (await import('openai')).default;
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const response = await client.chat.completions.create({
    model: modelId,
    temperature: options.temperature,
    max_completion_tokens: options.maxTokens,
    response_format: { type: 'json_object' },
    messages: [{ role: 'user', content: prompt }]
  });

  return {
    text: response.choices[0].message.content,
    tokensIn: response.usage.prompt_tokens,
    tokensOut: response.usage.completion_tokens
  };
}

/**
 * Call Google Gemini model
 */
async function callGemini(modelId, prompt, options) {
  const { GoogleGenerativeAI } = await import('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
  const model = genAI.getGenerativeModel({ model: modelId });

  const result = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: options.temperature,
      topP: 0.8,
      maxOutputTokens: options.maxTokens,
      responseMimeType: 'application/json'
    }
  });

  const response = result.response;
  return {
    text: response.text(),
    tokensIn: response.usageMetadata?.promptTokenCount || 0,
    tokensOut: response.usageMetadata?.candidatesTokenCount || 0
  };
}

/**
 * Parse JSON from model response, handling markdown code fences
 */
export function parseJsonResponse(text) {
  // Try direct parse first
  try {
    return JSON.parse(text);
  } catch (e) {
    // Try stripping markdown code fences
    const stripped = text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
    try {
      return JSON.parse(stripped);
    } catch (e2) {
      // Try extracting JSON object
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
      throw new Error('Failed to parse JSON from model response');
    }
  }
}

export default { callModel, parseJsonResponse };
