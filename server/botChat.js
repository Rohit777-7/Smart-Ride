// Reply engine for simulated (bot) drivers in the in-app chat. No external AI service:
// it reads the rider's message, works out what they're asking (several things at once
// is fine), and answers in character using the live trip details.
import { haversineKm } from './geo.js';
import { VEHICLES } from './fare.js';

const CITY_SPEED_KMH = 24;
const pick = (list) => list[Math.floor(Math.random() * list.length)];
const firstName = (name) => (name || '').trim().split(/\s+/)[0] || '';
const shortPlace = (address) => (address || '').split(',')[0].trim() || 'your destination';
const inr = (n) => `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;

/** Live numbers the replies refer to. */
function facts(ctx) {
  const driverPos = ctx.driver_lat != null ? { lat: ctx.driver_lat, lng: ctx.driver_lng } : null;
  const pickup = { lat: ctx.pickup_lat, lng: ctx.pickup_lng };
  const drop = { lat: ctx.drop_lat, lng: ctx.drop_lng };
  const toPickupKm = driverPos ? haversineKm(driverPos, pickup) * 1.35 : null;
  const toDropKm = ctx.status === 'in_progress' && driverPos ? haversineKm(driverPos, drop) * 1.3 : Number(ctx.distance_km) || null;
  const mins = (km) => (km == null ? null : Math.max(1, Math.round((km / CITY_SPEED_KMH) * 60)));
  const vehicle = VEHICLES[ctx.vehicle_type] || VEHICLES.mini;
  return {
    rider: firstName(ctx.passenger_name) || 'there',
    me: firstName(ctx.driver_name) || 'your driver',
    car: [ctx.vehicle_color, ctx.vehicle_model].filter(Boolean).join(' ') || vehicle.name,
    plate: ctx.vehicle_number || 'shown in the app',
    vehicle,
    isBike: ctx.vehicle_type === 'bike',
    isAuto: ctx.vehicle_type === 'auto',
    pickupName: shortPlace(ctx.pickup_address),
    dropName: shortPlace(ctx.drop_address),
    fare: ctx.final_fare ?? ctx.est_fare,
    pay: ctx.payment_method,
    toPickupKm,
    toPickupMin: mins(toPickupKm),
    toDropKm,
    toDropMin: mins(toDropKm),
  };
}

const km = (n) => `${n < 1 ? n.toFixed(1) : Math.round(n * 10) / 10} km`;

// Each intent: a test on the normalised message and a reply builder.
// Order matters: earlier intents win when several match.
const INTENTS = [
  {
    id: 'safety',
    test: /\b(unsafe|scared|afraid|emergency|sos|police|harass|danger|help me)\b/,
    reply: () => 'If you ever feel unsafe, please press the SOS button in the app straight away. It alerts RideFlow and your emergency contacts.',
  },
  {
    id: 'bot',
    test: /\b(are you|r u|is this)\b.*\b(bot|robot|ai|real|human|person|automatic)\b|\bchat ?bot\b/,
    reply: () => "Honest answer: I'm a simulated demo driver, so my replies are automatic. A real driver would chat with you here.",
  },
  {
    id: 'riderName',
    test: /\b(what('?s| is)? my name|my name\??$|who am i|do you know (me|my name)|tell me my name|mera naam)\b/,
    reply: (f) => pick([`You're ${f.rider}, right? Your name shows on my booking.`, `It's ${f.rider}! I can see it on the trip details.`]),
  },
  {
    id: 'driverName',
    test: /\b(your name|who are you|who is this|who('?s| is) (my|the) driver|what should i call you|aapka naam|tumhara naam)\b/,
    reply: (f) => `I'm ${f.me}, your RideFlow driver today.`,
  },
  {
    id: 'howAreYou',
    test: /\b(how are you|how r u|how('?s| is) it going|how('?s| is) your day|kaise ho|kaisa hai)\b/,
    reply: (f) => pick([`I'm doing well, thanks for asking ${f.rider}! How about you?`, 'All good, thank you! Hope your day is going well too.']),
  },
  {
    id: 'carId',
    test: /\b(which|what) (car|vehicle|bike|auto|colou?r)\b|\b(number plate|plate( number)?|registration|car number|gaadi|vehicle number)\b|how (will|do|can) i (find|recogni[sz]e|identify|spot) you|what do you look like/,
    reply: (f, s) => `It's a ${f.car}, number plate ${f.plate}.${s === 'arrived' ? " I'm parked right at the pickup point." : ''}`,
  },
  {
    id: 'eta',
    test: /\b(where are you|where r u|how long|how much (more )?time|eta|when will (you|we)|how far|kahan|kaha ho|kitni der|kitna time|reach(ing)?|arriv(e|ing)|are you (near|close|coming)|on the way|kab tak)\b/,
    reply: (f, s) => {
      if (s === 'accepted') {
        if (f.toPickupKm != null && f.toPickupKm < 0.15) return "I'm just around the corner, almost at the pickup!";
        return f.toPickupMin
          ? `I'm about ${f.toPickupMin} min away (${km(f.toPickupKm)}), heading to ${f.pickupName}.`
          : `I'm on my way to ${f.pickupName} and will be there shortly.`;
      }
      if (s === 'arrived') return `I'm already at the pickup point near ${f.pickupName}.`;
      if (s === 'in_progress') {
        return f.toDropMin
          ? `We're about ${f.toDropMin} min from ${f.dropName}, roughly ${km(f.toDropKm)} to go.`
          : `We're on the way to ${f.dropName}.`;
      }
      return 'Let me check the app.';
    },
  },
  {
    id: 'riderLocation',
    test: /\b(i('?m| am) (at|near|outside|in front|opposite|standing|waiting|here|inside|by|next to)|main gate|gate( no| number)?|lobby|entrance|exit|opposite|landmark|building|tower|block|basement|parking|bus stop|metro|signal)\b/,
    reply: (f, s) => {
      if (s === 'accepted') return pick([`Got it, I'll come there. Look for a ${f.car} (${f.plate}).`, `Okay, noted! I'll pick you up there. I'm in a ${f.car}.`]);
      if (s === 'arrived') return `Okay, coming to you now. I'm in the ${f.car}, plate ${f.plate}.`;
      return 'Okay, noted.';
    },
  },
  {
    id: 'changeDest',
    test: /\b(change|update|different|another|new) (the )?(destination|drop|address|location|place)\b|\bdrop me (at|near|before)\b|\b(go|take me) to\b/,
    reply: () => 'Sure, please update the destination in the app and I will follow the new route. The fare updates with it.',
  },
  {
    id: 'fare',
    test: /\b(fare|price|cost|how much|kitna|kitne|charge[sd]?|amount|total|bill)\b/,
    reply: (f) => (f.fare
      ? `The fare in the app is ${inr(f.fare)}${f.pay === 'cash' ? ', payable in cash' : f.pay === 'wallet' ? ', paid from your RideFlow wallet' : f.pay === 'card' ? ', charged to your card' : ''}. RideFlow calculates it, so there is nothing extra from my side.`
      : 'The fare is shown in the app. RideFlow calculates it, so there is nothing extra from my side.'),
  },
  {
    id: 'payment',
    test: /\b(pay|payment|upi|gpay|phonepe|paytm|cash|card|wallet|change for|chutta|online)\b/,
    reply: (f, _s, t) => {
      if (f.pay === 'cash' && /upi|gpay|phonepe|paytm|online/.test(t)) return `Sure, UPI works for me too. Just pay the ${f.fare ? inr(f.fare) + ' ' : ''}fare at the end of the trip.`;
      if (f.pay === 'cash') return `You can pay ${f.fare ? inr(f.fare) + ' ' : ''}in cash at the end of the trip. I have change.`;
      if (f.pay === 'wallet') return 'It is paid from your RideFlow wallet automatically, so nothing to pay me directly.';
      if (f.pay === 'card') return 'It is charged to your card automatically at the end. Nothing to pay me directly.';
      return 'Payment is handled in the app at the end of the trip.';
    },
  },
  {
    id: 'pin',
    test: /\b(pin|otp|code)\b/,
    reply: (_f, s) => (s === 'in_progress'
      ? 'The trip has already started, so no PIN is needed now.'
      : 'Please tell me the 4-digit trip PIN only once you are in the vehicle. Never share it in chat.'),
  },
  {
    id: 'hurry',
    test: /\b(hurry|quick(ly)?|fast(er)?|urgent|late for|jaldi|asap|in a rush)\b/,
    reply: (_f, s) => (s === 'in_progress'
      ? "I'll take the quickest route, while keeping it safe."
      : "I'll get there as quickly as I safely can."),
  },
  {
    id: 'slow',
    test: /\b(slow(ly|er| down)?|careful(ly)?|drive safe(ly)?|too fast|speed(ing)?|dheere|aaram se)\b/,
    reply: () => 'Sure, I will slow down. Safety first.',
  },
  {
    id: 'route',
    test: /\b(route|shortcut|which way|traffic|google maps|wrong way|turn (left|right)|highway|flyover|toll)\b/,
    reply: (_f, s, t) => {
      if (/toll/.test(t)) return 'If the route has a toll, it is added to the fare as per the app.';
      if (/traffic/.test(t)) return pick(['There is a bit of traffic, but we are moving.', 'Traffic looks okay, we should be fine.']);
      return s === 'in_progress'
        ? "I'm following the app's route; it's the fastest one right now. Tell me if you'd prefer another way."
        : "I'm following the app's route to the pickup.";
    },
  },
  {
    id: 'ac',
    test: /\b(ac|a\/c|air ?con(ditioning)?|cooling|too (hot|cold)|it'?s (hot|cold)|garmi|thand|temperature)\b/,
    reply: (f, _s, t) => {
      if (f.isBike || f.isAuto) return `Sorry, this ${f.vehicle.name.toLowerCase()} doesn't have AC.`;
      return /cold|thand|turn off|switch off|off/.test(t) ? "Sure, I'll turn the AC down." : "Sure, I'll turn on the AC.";
    },
  },
  {
    id: 'music',
    test: /\b(music|song|songs|radio|volume|loud|gaana|gaane|bluetooth|aux)\b/,
    reply: (_f, _s, t) => (/loud|lower|reduce|turn (it )?down|off|band/.test(t)
      ? "Okay, I'll turn it down."
      : "Sure! I'll put some music on. Tell me if you want it louder or quieter."),
  },
  {
    id: 'window',
    test: /\b(windows?|khidki)\b/,
    reply: (_f, _s, t) => (/close|up|band/.test(t) ? "Sure, I'll close the window." : "Sure, I'll roll the window down."),
  },
  {
    id: 'stop',
    test: /\b(stop|pull over|washroom|toilet|restroom|atm|medical|pharmacy|shop|quick stop|ruk(o|na|iye)|break)\b/,
    reply: (_f, s) => (s === 'in_progress'
      ? "Sure, I'll stop at a safe spot just ahead. Waiting time may be added to the fare."
      : 'Okay, no problem.'),
  },
  {
    id: 'wait',
    test: /\b(wait|minute|minutes|mins?|coming|be there|running late|give me|one sec|2 min|5 min|aa raha|aa rahi|aata|aati)\b/,
    reply: (_f, s) => (s === 'in_progress'
      ? 'Sure, no problem.'
      : pick(["No problem, I'll wait for you. Waiting time may apply after a few minutes.", "Okay, take your time. I'm waiting."])),
  },
  {
    id: 'luggage',
    test: /\b(luggages?|bags?|suitcases?|boot|trunk|dikki|saman|samaan)\b/,
    reply: (f) => (f.isBike
      ? "It's a bike, so only a small backpack or bag will fit."
      : f.isAuto ? 'An auto can take a couple of small bags, but not large suitcases.' : 'Yes, there is space in the boot for your bags.'),
  },
  {
    id: 'pets',
    test: /\b(pets?|dogs?|pupp(y|ies)|cats?)\b/,
    reply: () => 'Small pets are fine if they stay in a carrier or on your lap.',
  },
  {
    id: 'seats',
    test: /\b(kids?|child(ren)?|baby|child seat|car seat|friends?|people|persons|passengers|how many|seats?)\b/,
    reply: (f) => `This ${f.vehicle.name.toLowerCase()} fits up to ${f.vehicle.seats} passenger${f.vehicle.seats === 1 ? '' : 's'}${f.isBike ? ', and a helmet is provided' : ''}.`,
  },
  {
    id: 'call',
    test: /\b(call|phone|ring|number)\b/,
    reply: () => "Sure, you can call me with the Call button in the app. I'll call you if I can't find you.",
  },
  {
    id: 'cancel',
    test: /\bcancel/,
    reply: () => 'Okay. If you need to cancel, you can do it from the app. A small fee may apply after the free cancellation window.',
  },
  {
    id: 'lost',
    test: /\b(forgot|left (my|something|behind)|lost (my)?|missing)\b/,
    reply: () => 'Let me check the vehicle. You can also report it from your trip receipt under "Get help".',
  },
  {
    id: 'language',
    test: /\b(hindi|kannada|tamil|telugu|marathi|english|language|bhasha)\b/,
    reply: () => 'I can chat in English or Hindi, whichever you prefer.',
  },
  {
    id: 'weather',
    test: /\b(rain|raining|weather|baarish)\b/,
    reply: () => "It's fine out here. I'll drive carefully either way.",
  },
  {
    id: 'rating',
    test: /\b(tip|rating|rate|review|feedback|stars?)\b/,
    reply: () => 'Thank you! You can rate the trip and leave feedback in the app after the ride.',
  },
  {
    id: 'thanks',
    test: /\b(thanks|thank you|thx|ty|thnx|dhanyavad|shukriya)\b/,
    reply: (f) => pick([`You're welcome, ${f.rider}!`, 'Happy to help!', 'Anytime!']),
  },
  {
    id: 'sorry',
    test: /\b(sorry|my bad|apolog)/,
    reply: () => 'No problem at all!',
  },
  {
    id: 'bye',
    test: /\b(bye|see you|good ?night|take care|tata)\b/,
    reply: (f) => `Take care, ${f.rider}!`,
  },
];

const GREETING = /^(hi+|hello+|hey+|hii+|namaste|namaskar|good (morning|afternoon|evening)|yo|hola|bhaiya|bhai|sir|madam)\b[\s,!.]*/;
const ACK = /^(ok(ay)?|k+|fine|alright|sure|cool|got it|great|nice|perfect|haan|ha|hmm+|yes|yeah|yep|ji|theek hai|thik hai|done|👍)[\s!.]*$/;
const NO = /^(no|nope|nah|nahi|na)[\s!.]*$/;

function greetingReply(f, s) {
  if (s === 'accepted') return f.toPickupMin ? `Hi ${f.rider}! I'm on my way, about ${f.toPickupMin} min from the pickup.` : `Hi ${f.rider}! I'm on my way to the pickup.`;
  if (s === 'arrived') return `Hi ${f.rider}! I've reached the pickup point.`;
  return `Hi ${f.rider}! We're on our way to ${f.dropName}.`;
}

function fallbackReply(f, s, t) {
  const isQuestion = /\?\s*$/.test(t) || /^(what|why|how|when|where|who|which|can|could|will|would|do|does|is|are|should|kya|kaise|kyun|kab)\b/.test(t);
  if (isQuestion) {
    return pick([
      "Sorry, I'm driving so I can't answer that properly right now. Is it about the trip? I can help with the route, timing, fare or pickup.",
      "I'm not sure about that one, sorry! For the trip I can help with timing, pickup spot, fare or payment.",
    ]);
  }
  if (s === 'accepted') return pick(['Okay, noted. See you at the pickup soon!', 'Got it 👍 On my way.']);
  if (s === 'arrived') return pick(["Okay! I'm waiting at the pickup point.", 'Noted 👍 I am at the pickup.']);
  return pick(['Okay, noted.', 'Sure 👍']);
}

/**
 * Build the bot driver's reply to one or more rider messages.
 * @param {object} ctx  ride row with passenger/driver/vehicle/location fields
 * @param {string} text the rider's message(s), joined
 */
export function botReply(ctx, text) {
  const f = facts(ctx);
  const s = ctx.status;
  const t = String(text).toLowerCase().replace(/[’`]/g, "'").replace(/\s+/g, ' ').trim();

  const greeted = GREETING.test(t);
  const rest = t.replace(GREETING, '').trim();
  if (!rest) return greetingReply(f, s);
  if (ACK.test(rest)) return pick([s === 'in_progress' ? '👍' : 'Great, see you soon!', '👍']);
  if (NO.test(rest)) return 'Okay, no problem.';

  // Answer up to two different things the rider asked about, in priority order.
  const parts = [];
  for (const intent of INTENTS) {
    if (parts.length >= 2) break;
    if (intent.test.test(rest)) parts.push(intent.reply(f, s, rest));
  }
  const body = parts.length ? parts.join(' ') : fallbackReply(f, s, rest);
  return greeted ? `Hi ${f.rider}! ${body}` : body;
}
