/**
 * Reference architectures per organisation type.
 *
 * These are illustrative, not customer case studies: no VoiceKernel deployment
 * is described here and no organisation is named. They exist because "an
 * agentic voice layer" means very little until someone sees which of their own
 * systems it would touch, and a bank's answer is not an insurer's.
 *
 * Kept as data rather than six hand-written pages so the layer model stays
 * identical across sectors - the point being that only the bottom layer
 * changes.
 */

export const SECTORS = [
  {
    "slug": "banking",
    "name": "Banking",
    "eyebrow": "Retail & business banking",
    "headline": "Answer like the branch. Prove it like the regulator.",
    "intro": "A retail bank runs several high-volume queues that are almost entirely verification followed by a lookup and a status change. The conversation is the bottleneck, not the decision.",
    "metric": "Card disputes, balance enquiries and payment status routinely make up the top three queues by volume in retail banking.",
    "systems": [
      {
        "name": "Core banking",
        "detail": "accounts, balances, holds"
      },
      {
        "name": "Card management",
        "detail": "block, reissue, disputes"
      },
      {
        "name": "Fraud & AML",
        "detail": "case creation, risk signals"
      },
      {
        "name": "CRM",
        "detail": "interaction history"
      },
      {
        "name": "IAM / KYC",
        "detail": "step-up verification"
      }
    ],
    "journeys": [
      {
        "title": "Card disputes",
        "detail": "Identify the transaction, capture the dispute reason, raise the case in the fraud system, block and reissue the card, and read back a reference number."
      },
      {
        "title": "Balance and transactions",
        "detail": "Verify, answer from the core, and offer a statement without a human ever joining."
      },
      {
        "title": "Collections and hardship",
        "detail": "Explain options, capture a commitment, and hand a warm transfer to a person the moment distress is detected."
      }
    ],
    "compliance": [
      {
        "title": "Every word audited",
        "detail": "Full transcript and an audit row per mutation, with the actor and request id."
      },
      {
        "title": "Verification before disclosure",
        "detail": "No account data spoken until step-up succeeds; the tool call simply is not available before then."
      },
      {
        "title": "Right to erasure",
        "detail": "Redaction in place, so the call stays auditable while personal data goes."
      }
    ]
  },
  {
    "slug": "insurance",
    "name": "Insurance",
    "eyebrow": "General & life insurance",
    "headline": "From first notice of loss to renewal, without the hold music.",
    "intro": "Claims intake is structured data collection conducted under stress. It is also the moment that decides the customer's view of the insurer for the next three years.",
    "metric": "FNOL calls are long, highly structured, and almost entirely fixed questions - the shape of work a voice agent handles without judgement.",
    "systems": [
      {
        "name": "Policy administration",
        "detail": "cover, excess, endorsements"
      },
      {
        "name": "Claims system",
        "detail": "FNOL, status, payments"
      },
      {
        "name": "Document store",
        "detail": "photos, PDS, correspondence"
      },
      {
        "name": "CRM",
        "detail": "renewal and retention"
      },
      {
        "name": "Payments",
        "detail": "excess collection"
      }
    ],
    "journeys": [
      {
        "title": "First notice of loss",
        "detail": "Capture what happened, when, where and who else was involved; create the claim; send the upload link before the call ends."
      },
      {
        "title": "Claims status",
        "detail": "Answer from the claims system rather than a queue, including what is blocking and what the customer must do next."
      },
      {
        "title": "Renewals and retention",
        "detail": "Explain the premium change against last year, and transfer to a licensed human the instant the conversation turns to advice."
      }
    ],
    "compliance": [
      {
        "title": "General-advice guardrails",
        "detail": "The agent states factual information and refuses to recommend, with the boundary in the prompt and enforced by tool availability."
      },
      {
        "title": "Evidence trail",
        "detail": "Every claim field the agent captured, with the utterance it came from."
      },
      {
        "title": "Consent capture",
        "detail": "Recording consent taken and stored before anything else."
      }
    ]
  },
  {
    "slug": "superannuation",
    "name": "Superannuation",
    "eyebrow": "Funds & member services",
    "headline": "Member service that scales without scaling headcount.",
    "intro": "Member enquiries spike hard around statements, market moves and legislative change - the times when hiring is least practical and being unreachable is most damaging.",
    "metric": "Statement season concentrates a year of enquiries into a few weeks.",
    "systems": [
      {
        "name": "Registry",
        "detail": "balances, contributions, units"
      },
      {
        "name": "Member portal",
        "detail": "SSO and secure messaging"
      },
      {
        "name": "Insurance-in-super",
        "detail": "cover and claims"
      },
      {
        "name": "CRM",
        "detail": "member interactions"
      },
      {
        "name": "Advice desk",
        "detail": "licensed escalation"
      }
    ],
    "journeys": [
      {
        "title": "Balance and contributions",
        "detail": "Verify the member, read the balance and the last contributions, and explain a gap without speculating."
      },
      {
        "title": "Investment switches",
        "detail": "Explain options factually, record intent, and hand to a licensed person where advice begins."
      },
      {
        "title": "Outbound member campaigns",
        "detail": "Proactive contact for lost members or insufficient contributions, with DNC wash and a hard stop on dead lines."
      }
    ],
    "compliance": [
      {
        "title": "Advice boundary",
        "detail": "Factual information only; anything resembling personal advice transfers, and the transfer point is auditable."
      },
      {
        "title": "Member privacy",
        "detail": "Verification before any balance is spoken, and erasure on request."
      },
      {
        "title": "Campaign governance",
        "detail": "Budget and no-dead-line policy enforced before a campaign can start."
      }
    ]
  },
  {
    "slug": "telco",
    "name": "Telco & Utilities",
    "eyebrow": "Carriers, energy and water",
    "headline": "Outages are a communication problem before they are an engineering one.",
    "intro": "When something breaks, the call volume arrives all at once and every caller wants the same three facts. Meanwhile the connection, move and billing queues do not pause.",
    "metric": "An outage turns a steady inbound queue into a spike in minutes, which is exactly when hold times damage trust most.",
    "systems": [
      {
        "name": "OSS / network",
        "detail": "outage status by address"
      },
      {
        "name": "Billing",
        "detail": "invoices, plans, usage"
      },
      {
        "name": "Provisioning",
        "detail": "connections and moves"
      },
      {
        "name": "Field service",
        "detail": "appointment booking"
      },
      {
        "name": "CRM",
        "detail": "case history"
      }
    ],
    "journeys": [
      {
        "title": "Outage notifications",
        "detail": "Outbound at scale with the current restoration estimate, and inbound answering the same from the same source."
      },
      {
        "title": "Billing enquiries",
        "detail": "Explain a bill line by line against usage, and take a payment arrangement."
      },
      {
        "title": "Connections and moves",
        "detail": "Book the appointment, confirm the address, and write it back to field service."
      }
    ],
    "compliance": [
      {
        "title": "Do-not-call enforcement",
        "detail": "Washed before dialling, with the result recorded rather than assumed."
      },
      {
        "title": "Hardship handling",
        "detail": "Distress detection with immediate human transfer."
      },
      {
        "title": "Cost control",
        "detail": "Budget enforced at campaign creation, so a runaway outage broadcast is impossible."
      }
    ]
  },
  {
    "slug": "government",
    "name": "Government",
    "eyebrow": "Agencies & public services",
    "headline": "Every citizen answered. Every language. Every time.",
    "intro": "Public services cannot choose their callers. Access obligations, language coverage and data-residency rules apply on every call, and being unreachable is a policy failure rather than a metric.",
    "metric": "Data residency and auditability are usually the gating requirements, not accuracy.",
    "systems": [
      {
        "name": "Case management",
        "detail": "applications and status"
      },
      {
        "name": "Identity",
        "detail": "verification and proofing"
      },
      {
        "name": "Payments",
        "detail": "entitlements and debts"
      },
      {
        "name": "Knowledge base",
        "detail": "policy and eligibility"
      },
      {
        "name": "Records",
        "detail": "statutory retention"
      }
    ],
    "journeys": [
      {
        "title": "Application status",
        "detail": "Answer from the case system, explain what is outstanding, and say plainly what happens next."
      },
      {
        "title": "Multilingual access",
        "detail": "The same agent in the caller's language, with the transcript retained in both."
      },
      {
        "title": "Eligibility questions",
        "detail": "Grounded in published policy with citations, and explicit about what it cannot determine."
      }
    ],
    "compliance": [
      {
        "title": "Sovereign deployment",
        "detail": "Runs in your VPC or on-premises, in-region, with your keys and your models."
      },
      {
        "title": "Open source, auditable",
        "detail": "Your security team reads the code rather than a vendor summary of it."
      },
      {
        "title": "Statutory records",
        "detail": "Transcripts and audit rows retained on your terms, in your systems."
      }
    ]
  },
  {
    "slug": "health-administration",
    "name": "Health Administration",
    "eyebrow": "Providers & health funds",
    "headline": "Fill the schedule. Free the front desk.",
    "intro": "Administrative calls crowd out clinical work. Almost none of them require clinical judgement, and none of them should ever produce clinical advice.",
    "metric": "Reception time lost to administrative calls is time not spent with people who are physically present.",
    "systems": [
      {
        "name": "Practice management",
        "detail": "appointments and recalls"
      },
      {
        "name": "Patient records",
        "detail": "demographics only"
      },
      {
        "name": "Billing / claims",
        "detail": "fund and rebate enquiries"
      },
      {
        "name": "Referrals",
        "detail": "intake and triage routing"
      },
      {
        "name": "Consent register",
        "detail": "recording and contact"
      }
    ],
    "journeys": [
      {
        "title": "Appointment booking",
        "detail": "Offer real availability, book it, and confirm by message before the call ends."
      },
      {
        "title": "Recalls and reminders",
        "detail": "Outbound with consent checked, rescheduling in the same conversation."
      },
      {
        "title": "Billing and rebates",
        "detail": "Answer fund and rebate questions without touching clinical detail."
      }
    ],
    "compliance": [
      {
        "title": "No clinical advice",
        "detail": "A hard boundary in the prompt and in tool availability; symptom talk transfers immediately."
      },
      {
        "title": "Minimum necessary data",
        "detail": "The agent sees scheduling and billing fields, not the clinical record."
      },
      {
        "title": "Consent and erasure",
        "detail": "Recording consent captured per call; erasure redacts in place."
      }
    ]
  }
] as const;
