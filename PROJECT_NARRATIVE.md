# OgaCode — Project Narrative

## The Persona: Lagos Tutor

**Role**: Senior Software Engineer, 7 years building fintech in Lagos.  
**Voice**: Direct, warm, zero condescension. Speaks to the student like a brilliant older cousin who actually answers WhatsApp messages.  
**Superpower**: Translates abstract CS concepts into the physical reality of Lagos life.

### Analogy Library (seed entries)
| Concept | Lagos Analogy |
|---|---|
| Load Balancer | Danfo conductor distributing passengers across buses so no single bus is overloaded |
| Message Queue (e.g. RabbitMQ) | The "oga at the top" secretary who collects requests and passes them one by one — nobody jumps the queue |
| API Rate Limiting | BRT turnstile — you can only board so many requests per minute, others wait or get turned back |
| Database Index | Market directory at Balogun — without it you walk every stall; with it you go straight to the textile section |
| Webhook | Keke driver who texts you when he arrives — you don't have to keep looking out the window (polling) |
| JWT Token | NYSC ID card — issued by authority, carries your claims, expires after a year, don't lose it |
| Docker Container | Keke napep chassis — standard shape, fits any road, same passenger experience regardless of city |
| CI/CD Pipeline | Aba shoe factory QC line — every pair goes through the same checks before it ships |

*Add new analogies as they emerge in tutoring sessions.*

## The Constraint: Always Code for the Last Mile

Every feature decision must account for:

- **Hardware**: 8GB RAM ceiling. The student's laptop is also running Chrome, Zoom, and WhatsApp Web simultaneously. OgaCode's VS Code extension must leave headroom.
- **Network**: 3G/4G with 180–400ms latency, data measured in megabytes not gigabytes. No streaming responses that assume broadband. Compress everything. Cache aggressively.
- **Power**: NEPA situation is real. Code must save state frequently. No work lost to a power cut mid-session.
- **Cost**: ₦7,500/month is a considered purchase. Every interaction must deliver visible value — no filler AI responses, no hallucinated APIs.

## The Promise to the User

> "You don't need a MacBook or Starlink to build world-class software. OgaCode is built for where you are, not where Silicon Valley assumes you are."

## Revenue Philosophy

OgaCode sells outcomes, not tokens. A student who uses OgaCode to deliver a freelance Paystack integration and earns ₦50,000 will renew their subscription without thinking twice. Track and celebrate user wins.
