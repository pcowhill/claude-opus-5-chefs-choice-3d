import type { Rng } from '../core/rng'

export interface Stats {
  /** Base damage of one uncharged round. */
  damage: number
  /** Seconds to reach a full charge. */
  chargeTime: number
  /** Heat shed per second. */
  coolRate: number
  heatPerShot: number
  /** Water removed per second while bailing. */
  bailRate: number
  /** Multiplier on all incoming water. */
  floodResist: number
  /** Multiplier on recoil impulse -- i.e. on how fast you can move. */
  recoil: number
  grapePellets: number
  /** Hull capacity: how much water you can carry before you go under. */
  maxWater: number
  /** Extra beasts a round punches through. */
  pierce: number
  /** Blast radius of a round on impact, in metres. 0 = no splash damage. */
  splash: number
  projectileSpeed: number
  jamDuration: number
  /** Water bailed automatically per kill. */
  repairOnKill: number
  /** Rounds fired per pull of the main gun. */
  mainBalls: number
  /** Score multiplier from salvage rating. */
  salvage: number
}

export function baseStats(): Stats {
  return {
    damage: 10,
    chargeTime: 1.0,
    coolRate: 21,
    heatPerShot: 16,
    bailRate: 26,
    floodResist: 1,
    recoil: 1,
    grapePellets: 7,
    maxWater: 100,
    pierce: 0,
    splash: 0,
    projectileSpeed: 1,
    jamDuration: 1.9,
    repairOnKill: 0,
    mainBalls: 1,
    salvage: 1,
  }
}

export type IconKey = 'gun' | 'anchor' | 'pump' | 'plank' | 'flame' | 'chain' | 'wave' | 'shot'

export interface Upgrade {
  id: string
  name: string
  desc: string
  icon: IconKey
  repeatable?: boolean
  apply: (s: Stats) => void
}

export const UPGRADES: readonly Upgrade[] = [
  {
    id: 'rifled',
    name: 'Rifled Bore',
    desc: 'Grooved barrel. +35% round damage, +12% muzzle velocity.',
    icon: 'gun',
    apply: (s) => {
      s.damage *= 1.35
      s.projectileSpeed *= 1.12
    },
  },
  {
    id: 'coil',
    name: 'Copper Coil',
    desc: 'Seawater jacket around the breech. +45% cooling rate.',
    icon: 'wave',
    apply: (s) => {
      s.coolRate *= 1.45
    },
  },
  {
    id: 'pumps',
    name: 'Twin Bilge Pumps',
    desc: 'Bail 75% faster. Water is the only thing that kills you.',
    icon: 'pump',
    apply: (s) => {
      s.bailRate *= 1.75
    },
  },
  {
    id: 'gunwales',
    name: 'Sealed Gunwales',
    desc: 'Raised washboards. Take 30% less water from every source.',
    icon: 'plank',
    apply: (s) => {
      s.floodResist *= 0.7
    },
  },
  {
    id: 'monkey',
    name: 'Powder Monkey',
    desc: 'A quick pair of hands. Charge a full shot 35% faster.',
    icon: 'flame',
    apply: (s) => {
      s.chargeTime *= 0.65
    },
  },
  {
    id: 'chainshot',
    name: 'Chain Shot',
    desc: 'Two balls on a chain. Rounds punch through one extra beast.',
    icon: 'chain',
    apply: (s) => {
      s.pierce += 1
    },
  },
  {
    id: 'canister',
    name: 'Canister Load',
    desc: '+6 pellets in every blast of grape. Devastating up close.',
    icon: 'shot',
    apply: (s) => {
      s.grapePellets += 6
    },
  },
  {
    id: 'trunnions',
    name: 'Heavy Trunnions',
    desc: '+30% recoil. The gun kicks harder, so you travel further.',
    icon: 'gun',
    apply: (s) => {
      s.recoil *= 1.3
    },
  },
  {
    id: 'ballast',
    name: 'Ballast Stones',
    desc: 'Steady but sluggish. -20% recoil, -30% flooding, +15% hull.',
    icon: 'anchor',
    apply: (s) => {
      s.recoil *= 0.8
      s.floodResist *= 0.7
      s.maxWater *= 1.15
    },
  },
  {
    id: 'bursting',
    name: 'Bursting Shell',
    desc: 'Rounds detonate on impact. 3.6m blast, splash damage to all nearby.',
    icon: 'flame',
    apply: (s) => {
      s.splash = Math.max(s.splash, 3.6)
    },
  },
  {
    id: 'saltcrust',
    name: 'Salt Crust',
    desc: 'A jammed gun frees 55% faster, and the barrel runs cooler.',
    icon: 'wave',
    apply: (s) => {
      s.jamDuration *= 0.45
      s.coolRate += 6
    },
  },
  {
    id: 'planked',
    name: 'Double-Planked Hull',
    desc: '+30% hull capacity. Ship more water before you founder.',
    icon: 'plank',
    apply: (s) => {
      s.maxWater *= 1.3
    },
  },
  {
    id: 'scupper',
    name: 'Lucky Scupper',
    desc: 'Every beast you sink drains 3% of the water in your hull.',
    icon: 'pump',
    apply: (s) => {
      s.repairOnKill += 3
    },
  },
  {
    id: 'longnine',
    name: 'The Long Nine',
    desc: 'A finer, longer gun. +30% velocity, +18% damage, +15% heat.',
    icon: 'gun',
    apply: (s) => {
      s.projectileSpeed *= 1.3
      s.damage *= 1.18
      s.heatPerShot *= 1.15
    },
  },
  {
    id: 'doubleshot',
    name: 'Double-Shotted',
    desc: 'Two balls per pull, and a heavier kick. +40% heat per shot.',
    icon: 'shot',
    apply: (s) => {
      s.mainBalls += 1
      s.heatPerShot *= 1.4
      s.recoil *= 1.12
    },
  },
  {
    id: 'oilskin',
    name: 'Oilskin Cover',
    desc: 'Tarpaulin over the thwarts. Boarding seas ship 45% less water.',
    icon: 'plank',
    apply: (s) => {
      s.floodResist *= 0.55
    },
  },
  // ---- repeatables so a long run never runs out of choices
  {
    id: 'powder',
    name: 'Finer Powder',
    desc: '+14% round damage.',
    icon: 'flame',
    repeatable: true,
    apply: (s) => {
      s.damage *= 1.14
    },
  },
  {
    id: 'caulk',
    name: 'Fresh Caulking',
    desc: '-12% water taken from every source.',
    icon: 'plank',
    repeatable: true,
    apply: (s) => {
      s.floodResist *= 0.88
    },
  },
  {
    id: 'iron',
    name: 'Pig Iron Ballast',
    desc: '+10% hull capacity and a touch more cooling.',
    icon: 'anchor',
    repeatable: true,
    apply: (s) => {
      s.maxWater *= 1.1
      s.coolRate += 2
    },
  },
]

/** Three cards, never a duplicate of a one-shot upgrade already taken. */
export function draftUpgrades(taken: Set<string>, rng: Rng, count = 3): Upgrade[] {
  const pool = UPGRADES.filter((u) => u.repeatable || !taken.has(u.id))
  const picked = rng.shuffled(pool).slice(0, count)
  // Extremely defensive: if the unique pool ever empties, pad with repeatables.
  if (picked.length < count) {
    const rep = UPGRADES.filter((u) => u.repeatable)
    while (picked.length < count && rep.length) picked.push(rng.pick(rep))
  }
  return picked
}

/** Small engraved marks, one per upgrade family. Drawn as inline SVG on the cards. */
export const ICONS: Record<IconKey, string> = {
  gun: '<path d="M4 26 L4 20 L34 20 L34 12 L44 16 L44 24 L34 28 L34 20" /><circle cx="12" cy="30" r="5"/><path d="M4 26 L12 26"/>',
  anchor:
    '<circle cx="24" cy="8" r="4"/><path d="M24 12 L24 42"/><path d="M14 18 L34 18"/><path d="M10 30 C10 40 18 44 24 42 C30 44 38 40 38 30"/>',
  pump: '<path d="M18 44 L18 20 L30 20 L30 44 Z"/><path d="M24 20 L24 8"/><path d="M14 8 L34 8"/><path d="M30 30 L42 30 L42 44"/>',
  plank:
    '<path d="M6 14 L42 14 L42 22 L6 22 Z"/><path d="M6 26 L42 26 L42 34 L6 34 Z"/><path d="M16 14 L16 34"/><path d="M32 14 L32 34"/>',
  flame:
    '<path d="M24 6 C30 16 38 20 38 30 C38 38 32 44 24 44 C16 44 10 38 10 30 C10 22 16 20 18 12 C20 18 24 18 24 6 Z"/>',
  chain:
    '<circle cx="14" cy="16" r="8"/><circle cx="34" cy="32" r="8"/><path d="M20 21 L28 27"/>',
  wave: '<path d="M4 18 C10 10 16 26 24 18 C32 10 38 26 44 18"/><path d="M4 30 C10 22 16 38 24 30 C32 22 38 38 44 30"/>',
  shot: '<circle cx="14" cy="14" r="6"/><circle cx="32" cy="12" r="5"/><circle cx="22" cy="28" r="7"/><circle cx="36" cy="32" r="5"/><circle cx="10" cy="34" r="4"/>',
}
