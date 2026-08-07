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
    ],
    "benefits": [
      {
        "title": "Verification stops being the bottleneck",
        "detail": "The slow part of a card dispute is identifying the caller and the transaction, not deciding the outcome."
      },
      {
        "title": "Peak-hour abandonment falls structurally",
        "detail": "Every call is answered at once, so service level stops competing with the staffing budget."
      },
      {
        "title": "Regulatory evidence is a by-product",
        "detail": "Full transcript plus an audit row per mutation, produced without anyone remembering to write it down."
      },
      {
        "title": "Staff move to hardship and complaints",
        "detail": "The conversations that need judgement get the people who have it."
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
    ],
    "benefits": [
      {
        "title": "FNOL is captured completely, first time",
        "detail": "A fixed question set asked identically means fewer callbacks to fill gaps that stall the claim."
      },
      {
        "title": "Claims start moving immediately",
        "detail": "The claim exists in the system before the call ends, rather than after a queue of voicemails is worked."
      },
      {
        "title": "Advice risk is bounded by design",
        "detail": "The agent cannot recommend, because the tools to do so are not available to it."
      },
      {
        "title": "Renewal conversations happen at scale",
        "detail": "Retention outreach becomes a volume exercise rather than a staffing decision."
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
    ],
    "benefits": [
      {
        "title": "Statement season stops being a crisis",
        "detail": "The spike is absorbed instead of producing weeks of unanswered calls."
      },
      {
        "title": "The advice boundary is enforced, not trusted",
        "detail": "Where advice begins the call transfers, and the transfer point is auditable."
      },
      {
        "title": "Lost-member campaigns become practical",
        "detail": "Outbound at scale with do-not-call washing and budget control built in."
      },
      {
        "title": "Members get the same answer every time",
        "detail": "Consistency is the thing a fund is judged on when balances move."
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
    ],
    "benefits": [
      {
        "title": "Outage spikes are answerable",
        "detail": "Outbound at the scale of the event, so customers are told rather than left to ring."
      },
      {
        "title": "One source of truth for restoration",
        "detail": "Inbound and outbound quote the same estimate from the same system."
      },
      {
        "title": "Billing disputes de-escalate faster",
        "detail": "A line-by-line explanation available immediately, rather than after a wait that has already annoyed the caller."
      },
      {
        "title": "Runaway campaign spend is impossible",
        "detail": "Budget enforced before a campaign can start, not reconciled afterwards."
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
    ],
    "benefits": [
      {
        "title": "Access obligations met without a call centre",
        "detail": "Every citizen answered, in their language, at any hour."
      },
      {
        "title": "Auditability is inherent",
        "detail": "Transcripts and audit rows retained in your systems, on your terms."
      },
      {
        "title": "Sovereignty is provable, not promised",
        "detail": "It runs in your VPC with your keys, and your team reads the source."
      },
      {
        "title": "Staff time moves to complex cases",
        "detail": "Status enquiries stop consuming officers who should be assessing."
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
    ],
    "benefits": [
      {
        "title": "Reception time returns to people who are present",
        "detail": "Administrative calls stop competing with the person at the desk."
      },
      {
        "title": "Empty appointment slots get filled",
        "detail": "Availability is offered to callers instead of lost to voicemail."
      },
      {
        "title": "Recalls actually complete",
        "detail": "Outbound with rescheduling in the same conversation, rather than a letter that is ignored."
      },
      {
        "title": "Clinical risk is bounded by design",
        "detail": "The agent has no clinical tools and no clinical data, so it cannot advise even if asked."
      }
    ]
  },
  {
    "slug": "retail",
    "name": "Retail & E-commerce",
    "eyebrow": "Retail, marketplaces & DTC",
    "headline": "Where is my order, answered before the queue forms.",
    "intro": "Order status is the single largest contact driver in retail, and almost none of it needs a person. It is a lookup, a date, and sometimes a refund - repeated thousands of times a day, and concentrated into the weeks when staffing is hardest.",
    "systems": [
      {
        "name": "Order management",
        "detail": "orders, fulfilment, shipping"
      },
      {
        "name": "Returns / RMA",
        "detail": "authorisations and refunds"
      },
      {
        "name": "Payments",
        "detail": "refunds and chargebacks"
      },
      {
        "name": "Inventory",
        "detail": "stock and availability"
      },
      {
        "name": "CRM / helpdesk",
        "detail": "ticket history"
      }
    ],
    "journeys": [
      {
        "title": "Order and delivery status",
        "detail": "Verify the caller, read the current fulfilment state and the carrier estimate, and offer a text with the tracking link before the call ends."
      },
      {
        "title": "Returns and refunds",
        "detail": "Check eligibility against the policy, raise the RMA, issue the label, and tell the customer exactly when the money moves."
      },
      {
        "title": "Peak-season overflow",
        "detail": "Take the calls that would have queued during a sale, and hand the genuinely unusual ones to the humans who are now free to take them."
      }
    ],
    "benefits": [
      {
        "title": "Peak capacity without peak hiring",
        "detail": "Contact volume in retail is seasonal, but a trained agent is not hireable for four weeks. Voice absorbs the spike and releases it."
      },
      {
        "title": "Hold time stops being a cost trade-off",
        "detail": "Answering every call immediately no longer competes with the staffing budget, so service level stops being a quarterly negotiation."
      },
      {
        "title": "Refund decisions become consistent",
        "detail": "Policy is applied the same way at 3am on Boxing Day as at 10am on a Tuesday, and every decision carries the reason it was made."
      },
      {
        "title": "Human attention moves up the value chain",
        "detail": "Staff stop reading tracking numbers aloud and start handling the complaints that actually retain a customer."
      }
    ],
    "compliance": [
      {
        "title": "PCI scope stays where it is",
        "detail": "The agent reads status, not card numbers; payment capture stays in your existing flow."
      },
      {
        "title": "Refund limits enforced",
        "detail": "Value thresholds live in tool availability, so the agent cannot approve beyond its authority."
      },
      {
        "title": "Every decision auditable",
        "detail": "Which policy rule fired, on which order, at whose request."
      }
    ],
    "metric": "Order status, returns and delivery enquiries dominate retail contact volume, and all three are lookups against systems you already run."
  },
  {
    "slug": "logistics",
    "name": "Logistics & Freight",
    "eyebrow": "Carriers, 3PL & last mile",
    "headline": "The delivery window, confirmed by phone, at scale.",
    "intro": "Freight runs on confirmations - is someone at the dock, is the address right, can the driver get in. Each one is a thirty-second call that nobody has time to make, so exceptions are discovered on arrival instead.",
    "systems": [
      {
        "name": "TMS",
        "detail": "loads, routes, ETAs"
      },
      {
        "name": "WMS",
        "detail": "dock and slot booking"
      },
      {
        "name": "Track & trace",
        "detail": "carrier events"
      },
      {
        "name": "Driver app",
        "detail": "check-in and PoD"
      },
      {
        "name": "CRM",
        "detail": "shipper accounts"
      }
    ],
    "journeys": [
      {
        "title": "Delivery window confirmation",
        "detail": "Outbound the day before to confirm someone will be there, reschedule in the same call, and write it back to the route."
      },
      {
        "title": "Failed delivery recovery",
        "detail": "Call at the point of failure, find out what went wrong, and rebook before the parcel goes back to the depot."
      },
      {
        "title": "Dock and slot booking",
        "detail": "Take carrier calls for slot times and book them against the warehouse schedule without a person in the loop."
      }
    ],
    "benefits": [
      {
        "title": "Exceptions surface before the truck moves",
        "detail": "A wrong address found the night before costs a phone call; found on arrival it costs a failed delivery and a redelivery."
      },
      {
        "title": "Redelivery rates fall for a structural reason",
        "detail": "Most failures are absence, and absence is knowable in advance by asking."
      },
      {
        "title": "Drivers stop waiting on hold",
        "detail": "Slot booking and check-in are answered immediately rather than queued behind shipper enquiries."
      },
      {
        "title": "Coverage extends past office hours",
        "detail": "Freight moves overnight; the confirmation call no longer has to wait for a day shift."
      }
    ],
    "compliance": [
      {
        "title": "Address data minimised",
        "detail": "The agent confirms and corrects; it does not export the address book."
      },
      {
        "title": "Driver identity verified",
        "detail": "Check-in requires the load reference, not a name."
      },
      {
        "title": "Contact rules respected",
        "detail": "Consumer recipients are washed against do-not-call before any outbound run."
      }
    ],
    "metric": "A failed delivery costs the second attempt, the depot handling and the customer contact that follows - all of which start with nobody being home."
  },
  {
    "slug": "travel",
    "name": "Travel & Hospitality",
    "eyebrow": "Airlines, hotels & operators",
    "headline": "Disruption is a communications problem with a deadline.",
    "intro": "When a flight cancels or a property oversells, hundreds of people need the same three facts and one decision, simultaneously, and the phone system is the first thing to fail.",
    "systems": [
      {
        "name": "Reservation system",
        "detail": "bookings, inventory, fares"
      },
      {
        "name": "PMS / CRS",
        "detail": "property and rate availability"
      },
      {
        "name": "Loyalty",
        "detail": "tier, points, entitlements"
      },
      {
        "name": "Payments",
        "detail": "refunds and re-fares"
      },
      {
        "name": "Ops / disruption",
        "detail": "schedule changes"
      }
    ],
    "journeys": [
      {
        "title": "Disruption rebooking",
        "detail": "Call every affected passenger with the options that actually exist, take the choice, and rebook in the same conversation."
      },
      {
        "title": "Booking changes and cancellations",
        "detail": "Apply the fare rules honestly, quote the fee before changing anything, and confirm by message."
      },
      {
        "title": "Pre-arrival and concierge",
        "detail": "Confirm arrival time, capture requests, and route the ones that need a person to a person."
      }
    ],
    "benefits": [
      {
        "title": "The disruption spike stops being unanswerable",
        "detail": "Outbound at the scale of the disruption itself, so the airline calls the passenger rather than the other way round."
      },
      {
        "title": "Rebooking happens while inventory still exists",
        "detail": "Speed is the whole game; the seats go to whoever is contacted first, and contact is the constraint."
      },
      {
        "title": "Every language on every shift",
        "detail": "Multilingual coverage without recruiting for it, which matters most at 2am in a foreign airport."
      },
      {
        "title": "Fare rules applied consistently",
        "detail": "No discretionary variation under pressure, and every quote is recorded."
      }
    ],
    "compliance": [
      {
        "title": "Fare and fee transparency",
        "detail": "The agent states the cost before it commits the change, and the utterance is retained."
      },
      {
        "title": "Payment separation",
        "detail": "Re-fares route to your existing payment flow; the agent never handles the card."
      },
      {
        "title": "Consent for recording",
        "detail": "Captured per call and stored before anything else."
      }
    ],
    "metric": "Disruption volume arrives in minutes and decays in hours, which is precisely the shape no staffing model can meet."
  },
  {
    "slug": "automotive",
    "name": "Automotive",
    "eyebrow": "Dealerships, service & mobility",
    "headline": "Fill the service bays. Answer the roadside call.",
    "intro": "A service department loses bookings to unanswered phones while the advisors are with customers at the desk. The call is simple: what is wrong, when can you come, which car is it.",
    "systems": [
      {
        "name": "DMS",
        "detail": "vehicles, owners, history"
      },
      {
        "name": "Service scheduling",
        "detail": "bay capacity and slots"
      },
      {
        "name": "Parts",
        "detail": "availability for the job"
      },
      {
        "name": "Roadside / telematics",
        "detail": "incidents and location"
      },
      {
        "name": "CRM",
        "detail": "sales and retention"
      }
    ],
    "journeys": [
      {
        "title": "Service booking",
        "detail": "Identify the vehicle by rego, offer real bay availability, book it, and confirm what to bring."
      },
      {
        "title": "Service reminders",
        "detail": "Outbound recalls and scheduled maintenance, rescheduling in the same conversation."
      },
      {
        "title": "Roadside triage",
        "detail": "Capture location and symptoms, dispatch, and stay factual about arrival time."
      }
    ],
    "benefits": [
      {
        "title": "Bookings stop depending on who is free at the desk",
        "detail": "The phone is answered while advisors are with customers, which is exactly when it currently is not."
      },
      {
        "title": "Recall and maintenance campaigns actually complete",
        "detail": "Outbound at volume with rescheduling built in, rather than a letter that is ignored."
      },
      {
        "title": "Bay utilisation improves for a boring reason",
        "detail": "Empty slots are offered to callers instead of being lost to voicemail."
      },
      {
        "title": "After-hours enquiries convert",
        "detail": "Most service calls happen when the customer is not at work, which is when the department is closed."
      }
    ],
    "compliance": [
      {
        "title": "Vehicle identity before history",
        "detail": "Rego or VIN verified before any service record is spoken."
      },
      {
        "title": "Safety-critical escalation",
        "detail": "Symptoms that suggest a safety fault transfer to a person immediately."
      },
      {
        "title": "Marketing consent respected",
        "detail": "Retention campaigns wash against consent and do-not-call."
      }
    ],
    "metric": "Service departments are busiest at the desk and on the phone at the same hour, and only one of those has a person assigned."
  },
  {
    "slug": "education",
    "name": "Education",
    "eyebrow": "Universities, schools & training",
    "headline": "Enrolment season, answered.",
    "intro": "Student services face the same concentration problem every year: a term of enquiries compressed into three weeks, on topics that are almost entirely procedural, from people making a decision under a deadline.",
    "systems": [
      {
        "name": "Student management",
        "detail": "enrolment, results, fees"
      },
      {
        "name": "LMS",
        "detail": "course and timetable data"
      },
      {
        "name": "Admissions",
        "detail": "applications and offers"
      },
      {
        "name": "Finance",
        "detail": "fee schedules and plans"
      },
      {
        "name": "CRM",
        "detail": "prospect and student contact"
      }
    ],
    "journeys": [
      {
        "title": "Enrolment and admissions status",
        "detail": "Answer where an application sits, what is outstanding, and what the deadline actually is."
      },
      {
        "title": "Timetable, results and fees",
        "detail": "Verify the student, answer from the system of record, and set up a payment plan where one applies."
      },
      {
        "title": "Attendance and retention outreach",
        "detail": "Proactive contact for students who have stopped attending, with a human transfer the moment support is needed."
      }
    ],
    "benefits": [
      {
        "title": "Peak season stops degrading service",
        "detail": "The enquiry spike is absorbed rather than queued, at the exact moment a prospective student is comparing institutions."
      },
      {
        "title": "International students get their own hours",
        "detail": "Enquiries arrive across every timezone; coverage no longer depends on local working hours."
      },
      {
        "title": "Staff move to the conversations that need judgement",
        "detail": "Advisors stop quoting fee deadlines and start handling welfare and course advice."
      },
      {
        "title": "Retention outreach becomes feasible",
        "detail": "Contacting every disengaged student is a volume problem, not a difficulty problem."
      }
    ],
    "compliance": [
      {
        "title": "Student privacy",
        "detail": "Verification before any result or fee balance is spoken."
      },
      {
        "title": "Welfare escalation",
        "detail": "Distress detected in retention calls transfers immediately, and the boundary is enforced by tool availability."
      },
      {
        "title": "Records retention",
        "detail": "Transcripts held to your policy, in your systems."
      }
    ],
    "metric": "Enrolment enquiries concentrate a year of contact into a few weeks, against a staffing level set for the average."
  },
  {
    "slug": "real-estate",
    "name": "Real Estate & Property",
    "eyebrow": "Agencies & property management",
    "headline": "Every enquiry answered while the agent is at an inspection.",
    "intro": "Property runs on availability - of the agent, and of the property. The agent is showing a home when the calls about it arrive, and a maintenance issue reported on Friday night waits until Monday.",
    "systems": [
      {
        "name": "CRM / agency system",
        "detail": "listings, buyers, tenants"
      },
      {
        "name": "Property management",
        "detail": "leases and maintenance"
      },
      {
        "name": "Inspection scheduling",
        "detail": "viewings and open homes"
      },
      {
        "name": "Trust accounting",
        "detail": "rent and arrears"
      },
      {
        "name": "Contractor network",
        "detail": "job dispatch"
      }
    ],
    "journeys": [
      {
        "title": "Listing enquiries and viewings",
        "detail": "Answer questions about a property from the listing data, book the inspection, and confirm it."
      },
      {
        "title": "Tenant maintenance intake",
        "detail": "Capture the issue, decide urgency against your rules, dispatch to the contractor, and tell the tenant what happens next."
      },
      {
        "title": "Rent arrears outreach",
        "detail": "Factual, consistent contact with immediate transfer where hardship is disclosed."
      }
    ],
    "benefits": [
      {
        "title": "Enquiries convert when they arrive",
        "detail": "Buyer interest is perishable and arrives while the agent is unavailable by definition."
      },
      {
        "title": "After-hours maintenance is triaged, not stored",
        "detail": "Urgency is decided when the tenant calls, not when the office opens on Monday."
      },
      {
        "title": "Arrears contact becomes consistent",
        "detail": "The same conversation every time, with hardship handled by a person rather than avoided."
      },
      {
        "title": "Agents stop being switchboards",
        "detail": "Time moves from repeating listing details to negotiating and closing."
      }
    ],
    "compliance": [
      {
        "title": "Tenant privacy",
        "detail": "Lease details spoken only after verification against the tenancy."
      },
      {
        "title": "Hardship handling",
        "detail": "Disclosure of financial distress transfers immediately and is recorded."
      },
      {
        "title": "Urgency rules enforced",
        "detail": "What counts as an emergency repair is your policy, applied identically every time."
      }
    ],
    "metric": "Maintenance reported outside office hours is the most common source of tenant dissatisfaction, and the easiest to triage automatically."
  },
  {
    "slug": "recruitment",
    "name": "Recruitment & Workforce",
    "eyebrow": "Staffing, RPO & shift work",
    "headline": "Fill the shift before the client notices it is empty.",
    "intro": "Shift filling is a race conducted by phone. Hundreds of candidates, one vacancy, and whoever gets through first wins - which makes it a throughput problem, not a judgement problem.",
    "systems": [
      {
        "name": "ATS",
        "detail": "candidates, roles, pipeline"
      },
      {
        "name": "Rostering",
        "detail": "shifts and availability"
      },
      {
        "name": "Compliance",
        "detail": "tickets, licences, right to work"
      },
      {
        "name": "Payroll",
        "detail": "rates and timesheets"
      },
      {
        "name": "CRM",
        "detail": "client accounts"
      }
    ],
    "journeys": [
      {
        "title": "Shift filling",
        "detail": "Call the qualified pool in order, confirm availability, and assign the shift to the first who accepts, updating the roster live."
      },
      {
        "title": "Candidate screening",
        "detail": "Ask the qualifying questions consistently, capture the answers as structured data, and book the interview for anyone who passes."
      },
      {
        "title": "Compliance chasing",
        "detail": "Outbound for expiring tickets and licences, with the document link sent during the call."
      }
    ],
    "benefits": [
      {
        "title": "Fill rates improve because contact is parallel",
        "detail": "A recruiter calls one candidate at a time; the constraint is dialling, and that constraint disappears."
      },
      {
        "title": "Screening becomes comparable",
        "detail": "Every candidate answers the same questions in the same order, which is what makes the shortlist defensible."
      },
      {
        "title": "Compliance lapses are caught before they bite",
        "detail": "Expiring credentials are chased on schedule rather than discovered on site."
      },
      {
        "title": "Recruiters do the part that needs a recruiter",
        "detail": "Assessment and client relationships, not availability roll-calls."
      }
    ],
    "compliance": [
      {
        "title": "Right-to-work data handled carefully",
        "detail": "Captured into your ATS, not held by the voice layer."
      },
      {
        "title": "Screening consistency recorded",
        "detail": "Every question and answer retained with the call."
      },
      {
        "title": "Candidate contact preferences",
        "detail": "Do-not-call and consent enforced before any outbound run."
      }
    ],
    "metric": "An unfilled shift is lost revenue and a client relationship event, and it is lost to dialling speed more often than to candidate supply."
  },
  {
    "slug": "legal",
    "name": "Legal Services",
    "eyebrow": "Firms & legal operations",
    "headline": "Intake that never misses a matter.",
    "intro": "A missed first call is a missed client. Intake is highly structured - conflict check, matter type, urgency - and it is conducted by whoever happens to be at the desk.",
    "systems": [
      {
        "name": "Practice management",
        "detail": "matters, clients, deadlines"
      },
      {
        "name": "Conflict system",
        "detail": "conflict checks"
      },
      {
        "name": "Document management",
        "detail": "engagement and evidence"
      },
      {
        "name": "Billing / trust",
        "detail": "rates and disbursements"
      },
      {
        "name": "CRM",
        "detail": "enquiry pipeline"
      }
    ],
    "journeys": [
      {
        "title": "New enquiry intake",
        "detail": "Capture the matter type, the parties and the urgency, run the conflict check, and book the consultation."
      },
      {
        "title": "Matter status",
        "detail": "Tell an existing client where their matter sits and what is outstanding, without interrupting the fee earner."
      },
      {
        "title": "Deadline and appointment reminders",
        "detail": "Outbound for court dates and document deadlines, with rescheduling in the same call."
      }
    ],
    "benefits": [
      {
        "title": "First contact stops depending on availability",
        "detail": "Enquiries arrive when someone has just had a problem, which is rarely during a free moment at the firm."
      },
      {
        "title": "Conflict checks happen at intake",
        "detail": "Before any advice is given and before a relationship forms, which is when they are actually useful."
      },
      {
        "title": "Fee earners stop taking status calls",
        "detail": "Billable time stops being consumed by questions the practice management system can answer."
      },
      {
        "title": "Intake is uniform and evidenced",
        "detail": "Every enquiry captured the same way, with a transcript, which matters if the engagement is ever disputed."
      }
    ],
    "compliance": [
      {
        "title": "No legal advice",
        "detail": "A hard boundary in the prompt and in tool availability; anything advisory transfers to a practitioner."
      },
      {
        "title": "Privilege and confidentiality",
        "detail": "Transcripts held in your systems under your retention policy."
      },
      {
        "title": "Conflict before disclosure",
        "detail": "The agent takes the minimum needed to run the check and no more until it clears."
      }
    ],
    "metric": "Intake is the highest-value conversation a firm has and the one most often answered by whoever is closest to the phone."
  },
  {
    "slug": "care",
    "name": "Aged & Disability Care",
    "eyebrow": "Providers & support coordination",
    "headline": "A check-in call that actually happens, every day.",
    "intro": "Welfare checks and roster changes are high-frequency, low-complexity calls to people for whom a missed call has real consequences. They are the first thing dropped when staff are short.",
    "systems": [
      {
        "name": "Care management",
        "detail": "clients, plans, goals"
      },
      {
        "name": "Rostering",
        "detail": "shifts and support workers"
      },
      {
        "name": "Incident system",
        "detail": "reports and escalation"
      },
      {
        "name": "Funding / claims",
        "detail": "plan budgets and claims"
      },
      {
        "name": "Family contacts",
        "detail": "authorised representatives"
      }
    ],
    "journeys": [
      {
        "title": "Daily welfare check-ins",
        "detail": "A short, consistent conversation, with anything concerning escalated to a coordinator immediately and recorded."
      },
      {
        "title": "Roster changes",
        "detail": "Tell the client and the family when a support worker changes, and confirm they heard it."
      },
      {
        "title": "Appointment and transport reminders",
        "detail": "Outbound reminders with rescheduling handled in the same call."
      }
    ],
    "benefits": [
      {
        "title": "Check-ins stop being the thing that gets skipped",
        "detail": "They happen on schedule regardless of roster pressure, which is precisely when they matter most."
      },
      {
        "title": "Deterioration is noticed earlier",
        "detail": "A consistent daily conversation surfaces change that a fortnightly visit does not."
      },
      {
        "title": "Families are informed without extra staffing",
        "detail": "Roster changes reach the people who need to know, every time."
      },
      {
        "title": "Coordinators spend their time on escalations",
        "detail": "Not on confirming that tomorrow is still Tuesday."
      }
    ],
    "compliance": [
      {
        "title": "No clinical or care advice",
        "detail": "A hard boundary; anything clinical transfers to a qualified person immediately."
      },
      {
        "title": "Distress escalation",
        "detail": "Detected distress ends the script and reaches a human, and the transfer is auditable."
      },
      {
        "title": "Consent and representatives",
        "detail": "Who may be told what is enforced from the care record, not assumed."
      }
    ],
    "metric": "A daily check-in is only protective if it actually happens on the days when staffing is worst."
  },
  {
    "slug": "field-services",
    "name": "Field Services & Trades",
    "eyebrow": "Utilities contractors, HVAC & facilities",
    "headline": "Confirm the appointment. Free the dispatcher.",
    "intro": "Field work is scheduled by phone and derailed by phone. Confirmations, running-late calls and rebookings consume the dispatcher who is also supposed to be optimising the run.",
    "systems": [
      {
        "name": "Field service management",
        "detail": "jobs, technicians, routes"
      },
      {
        "name": "Scheduling",
        "detail": "windows and capacity"
      },
      {
        "name": "Asset / equipment",
        "detail": "service history"
      },
      {
        "name": "Parts inventory",
        "detail": "availability for the job"
      },
      {
        "name": "CRM / billing",
        "detail": "accounts and quotes"
      }
    ],
    "journeys": [
      {
        "title": "Appointment confirmation",
        "detail": "Outbound the day before, confirm access, and rebook in the same call if nobody will be there."
      },
      {
        "title": "Running-late notification",
        "detail": "Call the next customers when a job overruns, with a real revised window from the route."
      },
      {
        "title": "Job booking and triage",
        "detail": "Take the fault description, decide urgency and required skill, and book the right technician."
      }
    ],
    "benefits": [
      {
        "title": "Wasted truck rolls fall",
        "detail": "No-access is the most common failure and the most preventable by asking the day before."
      },
      {
        "title": "Dispatchers stop being a phone queue",
        "detail": "Route optimisation is a planning job that cannot be done while answering calls."
      },
      {
        "title": "Customers hear about delays before they complain",
        "detail": "The running-late call is the one nobody has time to make, and the one that decides satisfaction."
      },
      {
        "title": "Emergency triage is consistent",
        "detail": "Urgency assessed against your rules rather than the tone of the caller."
      }
    ],
    "compliance": [
      {
        "title": "Access and safety notes captured",
        "detail": "Recorded against the job so the technician arrives informed."
      },
      {
        "title": "Emergency escalation",
        "detail": "Gas, electrical and water emergencies transfer immediately, with no attempt to triage further."
      },
      {
        "title": "Site data minimised",
        "detail": "The agent reads what the job needs and nothing else."
      }
    ],
    "metric": "A no-access visit costs the travel, the slot and the rebooking, and is usually preventable with one call the night before."
  }
] as const;
