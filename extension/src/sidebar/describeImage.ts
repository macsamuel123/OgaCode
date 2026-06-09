const PROMPTS = {
  debug:
    'Describe this screenshot in detail for a developer debugging a bug. Include all visible: error messages, UI state, code, stack traces, console output, and any other relevant details.',
  design:
    'You are a senior UI/UX designer analysing a design reference screenshot. Describe it with extreme precision so a developer can replicate it exactly:\n' +
    '1. COLORS: List every color used — backgrounds, text, buttons, borders, gradients. Give hex or RGB values if visible.\n' +
    '2. LAYOUT: Describe the page structure — navbar, hero, sections, grid/flex arrangement, alignment.\n' +
    '3. TYPOGRAPHY: Font styles (serif/sans-serif), weights (bold/light), sizes (large heading vs body), line height, letter spacing.\n' +
    '4. COMPONENTS: Describe every UI element — cards (shadow, radius, padding), buttons (shape, color, text), forms, icons, images.\n' +
    '5. SPACING: Describe padding/margin generosity — tight or airy? Consistent gutters?\n' +
    '6. EFFECTS: Gradients, shadows, borders, hover states, animations visible in the screenshot.\n' +
    '7. OVERALL STYLE: e.g. "dark minimal SaaS", "bright playful e-commerce", "clean corporate". Be specific.\n' +
    'Be as detailed as possible. A developer will use your description alone to recreate this design.',
};

export async function describeImage(
  dataUrl: string,
  purpose: 'debug' | 'design',
  groqKey: string,
  serverUrl: string,
  token: string,
): Promise<string> {
  // Managed-server path: POST to /v1/vision (server uses its own Groq key)
  if (!groqKey && serverUrl && token) {
    return new Promise((resolve) => {
      const https  = require('https') as typeof import('https');
      const body   = JSON.stringify({ image: dataUrl, prompt: PROMPTS[purpose] });
      const parsed = new URL(serverUrl);
      const req = https.request({
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: '/v1/vision',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      }, (res: import('http').IncomingMessage) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk; });
        res.on('end', () => {
          try {
            const json = JSON.parse(data) as { description?: string };
            resolve(json.description ?? '');
          } catch { resolve(''); }
        });
      });
      req.on('error', () => resolve(''));
      req.setTimeout(20000, () => { req.destroy(); resolve(''); });
      req.write(body);
      req.end();
    });
  }

  if (!groqKey) { return ''; }

  // BYO path: call Groq directly with the user's own key
  const body = JSON.stringify({
    model: 'llama-3.2-11b-vision-preview',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: PROMPTS[purpose] },
        { type: 'image_url', image_url: { url: dataUrl } },
      ],
    }],
    max_tokens: purpose === 'design' ? 1200 : 800,
  });

  return new Promise((resolve) => {
    const https = require('https') as typeof import('https');
    const req = https.request({
      hostname: 'api.groq.com',
      path: '/openai/v1/chat/completions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${groqKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res: import('http').IncomingMessage) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data) as { choices?: Array<{ message?: { content?: string } }> };
          resolve(json.choices?.[0]?.message?.content ?? '');
        } catch { resolve(''); }
      });
    });
    req.on('error', () => resolve(''));
    req.setTimeout(15000, () => { req.destroy(); resolve(''); });
    req.write(body);
    req.end();
  });
}
