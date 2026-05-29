import { SIDES } from "./classes.js";
import { resolveSpec, deepMerge } from "./races.js";
import * as V from "./vec.js";
import { createProjectile, createMissile } from "./projectile.js";
import { getSprite, ENGINES, ENGINE_X, buildCells, killCellsForModule,
         rebuildBlockCanvas, preDamageBlockGrid, snapModulesSymmetric,
         getCellStats } from "./sprites.js";
import {
  buildModules, pdTurretToModuleName, podToModuleName, pickBomberAimModule,
  pickAimModule, moduleOffsetWorld, forwardGunModuleName, moduleLossSurvey,
} from "./modules.js";
import { events } from "./events.js";
import { applyBoonPatches, applyTraitFleetPatches } from "./roguelite.js";
import { applyDesign, flattenMissilePods, flattenHeavyLasers, flattenWeapons } from "./components.js";

// Build a per-weapon state object for ship.weapons[]. Each entry carries
// the weapon's spec plus its own cooldowns / salvo state / ammo /
// cannon-aim. This lets a BB with 2× Bow Cannon (or Bow + Mass Driver)
// fire each weapon independently — same pattern as the laser + missile
// flatten in earlier phases.
function makeWeaponState(spec, heading) {
  if (!spec) return null;
  return {
    spec,
    cooldown: 0,
    cooldownPort: 0,
    cooldownStarboard: 0,
    salvoShotsLeft: 0, salvoShotTimer: 0,
    salvoPortShotsLeft: 0, salvoPortShotTimer: 0,
    salvoStbdShotsLeft: 0, salvoStbdShotTimer: 0,
    weaponAmmo: spec.capacity ? spec.capacity : 0,
    weaponReloading: false,
    weaponReloadTimer: 0,
    // Cannon aim is per-weapon for turret-tracked classes (cruiser /
    // Thren carrier). Initialized at heading for non-jarring first frame.
    cannonAimAngle: null,  // set below for tracking-eligible classes
  };
}

let nextId = 1;

// Hull polygons per [race][klass]. Vertices are scaled by ship.spec.radius
// at draw time. Each race has its own visual language:
//   Terran   — utilitarian: triangles, trapezoids, hexagons.
//   Reavers  — angular, asymmetric, predatory spikes.
//   Hegemony — blocky, slabby, armored rectangles.
//   Voidsworn — sleek crescents and swept-wing curves.
const HULLS = {
  terran: {
    // Interceptor: needle prow, taut fuselage, hard-swept delta wings
    // pinned to the centreline mid-body, twin engine nacelles with a
    // centerline exhaust notch. Reads as a dart, not a fan.
    fighter:    [[1.00, 0.00], [0.78, 0.04], [0.55, 0.07], [0.32, 0.10],
                 [0.10, 0.13], [-0.05, 0.28], [-0.20, 0.46], [-0.32, 0.50],
                 [-0.42, 0.32], [-0.40, 0.18], [-0.60, 0.22], [-0.95, 0.18],
                 [-0.90, 0.05], [-0.72, 0.05], [-0.72, -0.05], [-0.90, -0.05],
                 [-0.95, -0.18], [-0.60, -0.22], [-0.40, -0.18], [-0.42, -0.32],
                 [-0.32, -0.50], [-0.20, -0.46], [-0.05, -0.28], [0.10, -0.13],
                 [0.32, -0.10], [0.55, -0.07], [0.78, -0.04]],
    // Heavy gunship: long lance prow, shouldered fuselage, stub
    // weapon-pod wings, distinct twin-engine block aft.
    bomber:     [[1.00, 0.00], [0.85, 0.06], [0.62, 0.12], [0.45, 0.20],
                 [0.20, 0.24], [0.05, 0.38], [-0.10, 0.56], [-0.24, 0.58],
                 [-0.34, 0.40], [-0.30, 0.22], [-0.50, 0.28], [-0.62, 0.46],
                 [-0.92, 0.44], [-0.98, 0.22], [-0.90, 0.08], [-0.78, 0.08],
                 [-0.78, -0.08], [-0.90, -0.08], [-0.98, -0.22], [-0.92, -0.44],
                 [-0.62, -0.46], [-0.50, -0.28], [-0.30, -0.22], [-0.34, -0.40],
                 [-0.24, -0.58], [-0.10, -0.56], [0.05, -0.38], [0.20, -0.24],
                 [0.45, -0.20], [0.62, -0.12], [0.85, -0.06]],
    // Escort frigate: sharp prow, stepped superstructure amidships, engine
    // block aft with a centerline thruster recess.
    frigate:    [[1.0, 0.00], [0.78, 0.10], [0.64, 0.13], [0.58, 0.28],
                 [0.40, 0.30], [0.30, 0.42], [0.05, 0.44], [-0.05, 0.30],
                 [-0.45, 0.34], [-0.55, 0.50], [-0.78, 0.48], [-0.80, 0.26],
                 [-0.95, 0.20], [-0.92, 0.07], [-0.74, 0.05], [-0.74, -0.05],
                 [-0.92, -0.07], [-0.95, -0.20], [-0.80, -0.26], [-0.78, -0.48],
                 [-0.55, -0.50], [-0.45, -0.34], [-0.05, -0.30], [0.05, -0.44],
                 [0.30, -0.42], [0.40, -0.30], [0.58, -0.28], [0.64, -0.13],
                 [0.78, -0.10]],
    // Strike cruiser: ram bow, stepped forward gun deck, broadside
    // sponsons amidships, aft engine wings + centerline thruster recess.
    // Long and directional, not a rounded blob.
    cruiser:    [[1.00, 0.00], [0.80, 0.09], [0.64, 0.11], [0.58, 0.26],
                 [0.42, 0.28], [0.36, 0.15], [0.12, 0.17], [0.04, 0.40],
                 [-0.24, 0.42], [-0.30, 0.21], [-0.54, 0.23], [-0.60, 0.48],
                 [-0.82, 0.46], [-0.84, 0.20], [-1.00, 0.15], [-0.92, 0.05],
                 [-0.74, 0.05], [-0.66, 0.00], [-0.74, -0.05], [-0.92, -0.05],
                 [-1.00, -0.15], [-0.84, -0.20], [-0.82, -0.46], [-0.60, -0.48],
                 [-0.54, -0.23], [-0.30, -0.21], [-0.24, -0.42], [0.04, -0.40],
                 [0.12, -0.17], [0.36, -0.15], [0.42, -0.28], [0.58, -0.26],
                 [0.64, -0.11], [0.80, -0.09]],
    // Dreadnought-class battleship: terraced bow turret tiers, tall
    // central citadel, layered broadside batteries, swept engine block +
    // centerline thruster recess. A heavy gun platform, not a blob.
    battleship: [[1.00, 0.00], [0.88, 0.12], [0.74, 0.15], [0.70, 0.33],
                 [0.54, 0.35], [0.50, 0.19], [0.40, 0.21], [0.36, 0.50],
                 [0.16, 0.53], [0.10, 0.33], [-0.10, 0.35], [-0.16, 0.67],
                 [-0.42, 0.70], [-0.46, 0.43], [-0.62, 0.45], [-0.66, 0.72],
                 [-0.84, 0.68], [-0.88, 0.34], [-1.00, 0.28], [-0.94, 0.10],
                 [-0.78, 0.07], [-0.70, 0.00], [-0.78, -0.07], [-0.94, -0.10],
                 [-1.00, -0.28], [-0.88, -0.34], [-0.84, -0.68], [-0.66, -0.72],
                 [-0.62, -0.45], [-0.46, -0.43], [-0.42, -0.70], [-0.16, -0.67],
                 [-0.10, -0.35], [0.10, -0.33], [0.16, -0.53], [0.36, -0.50],
                 [0.40, -0.21], [0.50, -0.19], [0.54, -0.35], [0.70, -0.33],
                 [0.74, -0.15], [0.88, -0.12]],
    // Fleet carrier: angled flight-deck bow, stepped deck edges + island,
    // recessed hangar mouth, broad engine bank aft.
    carrier:    [[1.0, 0.10], [0.95, 0.30], [0.55, 0.40], [0.50, 0.58],
                 [0.20, 0.60], [0.15, 0.42], [-0.55, 0.44], [-0.60, 0.62],
                 [-0.85, 0.60], [-0.88, 0.30], [-1.0, 0.24], [-0.96, 0.08],
                 [-0.96, -0.08], [-1.0, -0.24], [-0.88, -0.30], [-0.85, -0.60],
                 [-0.60, -0.62], [-0.55, -0.44], [0.15, -0.42], [0.20, -0.60],
                 [0.50, -0.58], [0.55, -0.40], [0.95, -0.30], [1.0, -0.10]],
    // Star fort: radial defense platform with projecting gun bastions
    // between recessed curtain bays — a structure, not a flat hexagon.
    station:    [[0.40, 0.00], [0.30, 0.20], [0.55, 0.30], [0.42, 0.52],
                 [0.16, 0.42], [0.00, 0.62], [-0.16, 0.42], [-0.42, 0.52],
                 [-0.30, 0.26], [-0.58, 0.20], [-0.46, 0.00], [-0.58, -0.20],
                 [-0.30, -0.26], [-0.42, -0.52], [-0.16, -0.42], [0.00, -0.62],
                 [0.16, -0.42], [0.42, -0.52], [0.55, -0.30], [0.30, -0.20]],
  },
  reavers: {
    // Barbed interceptor — fanged spear prow, sharp forward-hooked
    // wingtip barbs sweeping into a narrow waist, split tail with
    // exhaust spikes. Predator silhouette, not a wide blob.
    fighter:    [[1.00, 0.00], [0.72, 0.04], [0.55, 0.02], [0.45, 0.14],
                 [0.20, 0.10], [0.05, 0.22], [-0.08, 0.48], [-0.22, 0.42],
                 [-0.18, 0.22], [-0.34, 0.26], [-0.46, 0.50], [-0.58, 0.30],
                 [-0.52, 0.14], [-0.90, 0.18], [-0.72, 0.06], [-1.00, 0.04],
                 [-0.82, 0.00], [-1.00, -0.04], [-0.72, -0.06], [-0.90, -0.18],
                 [-0.52, -0.14], [-0.58, -0.30], [-0.46, -0.50], [-0.34, -0.26],
                 [-0.18, -0.22], [-0.22, -0.42], [-0.08, -0.48], [0.05, -0.22],
                 [0.20, -0.10], [0.45, -0.14], [0.55, -0.02], [0.72, -0.04]],
    // Scorpion striker — barbed claws forward, lean mid-body, twin
    // clawed rear flanks around a stinger tail. Lethal-looking, but
    // proportional — was a wide-bodied scorpion, now a swept raptor.
    bomber:     [[1.00, 0.00], [0.78, 0.08], [0.62, 0.06], [0.55, 0.20],
                 [0.36, 0.16], [0.22, 0.30], [0.05, 0.28], [-0.10, 0.50],
                 [-0.20, 0.62], [-0.35, 0.48], [-0.30, 0.30], [-0.48, 0.34],
                 [-0.62, 0.58], [-0.78, 0.40], [-0.70, 0.20], [-0.95, 0.22],
                 [-0.85, 0.08], [-1.00, 0.05], [-0.88, 0.00], [-1.00, -0.05],
                 [-0.85, -0.08], [-0.95, -0.22], [-0.70, -0.20], [-0.78, -0.40],
                 [-0.62, -0.58], [-0.48, -0.34], [-0.30, -0.30], [-0.35, -0.48],
                 [-0.20, -0.62], [-0.10, -0.50], [0.05, -0.28], [0.22, -0.30],
                 [0.36, -0.16], [0.55, -0.20], [0.62, -0.06], [0.78, -0.08]],
    // Pincer warship — barbed prow, serrated flanks, twin clawed rear
    // prongs around a central tail.
    frigate:    [[1.00,0.00],[0.62,0.12],[0.46,0.30],[0.30,0.24],[0.18,0.45],[-0.10,0.55],
                 [-0.05,0.28],[-0.35,0.34],[-0.42,0.62],[-0.60,0.50],[-0.55,0.24],[-0.85,0.30],
                 [-0.70,0.10],[-0.95,0.06],[-0.72,0.00],
                 [-0.95,-0.06],[-0.70,-0.10],[-0.85,-0.30],[-0.55,-0.24],[-0.60,-0.50],[-0.42,-0.62],
                 [-0.35,-0.34],[-0.05,-0.28],[-0.10,-0.55],[0.18,-0.45],[0.30,-0.24],[0.46,-0.30],[0.62,-0.12]],
    // Predator cruiser: serrated bow notch, twin lateral hooks, and
    // a barbed stern. Asymmetric-looking even though it's mirrored.
    cruiser:    [[1.0,  0.00], [0.85, 0.18], [0.62, 0.15], [0.55, 0.40],
                 [0.32, 0.42], [0.25, 0.70], [0.00, 0.78], [-0.25, 0.95],
                 [-0.40, 0.70], [-0.55, 0.85], [-0.70, 0.55], [-0.55, 0.35],
                 [-0.95, 0.25], [-0.75, 0.05], [-1.0, 0.00], [-0.75, -0.05],
                 [-0.95, -0.25], [-0.55, -0.35], [-0.70, -0.55], [-0.55, -0.85],
                 [-0.40, -0.70], [-0.25, -0.95], [0.00, -0.78], [0.25, -0.70],
                 [0.32, -0.42], [0.55, -0.40], [0.62, -0.15], [0.85, -0.18]],
    // Reaver flagship: tripled lateral barbs, recessed prow notch,
    // forked stern with a re-entrant centerline. Visually it bristles.
    battleship: [[1.0,  0.00], [0.92, 0.20], [0.70, 0.22], [0.65, 0.40],
                 [0.55, 0.65], [0.40, 0.50], [0.30, 0.85], [0.05, 0.70],
                 [-0.10, 0.95], [-0.30, 0.70], [-0.45, 0.95], [-0.60, 0.55],
                 [-0.55, 0.30], [-0.95, 0.40], [-0.75, 0.15], [-1.0,  0.05],
                 [-0.85, 0.00], [-1.0, -0.05], [-0.75, -0.15], [-0.95, -0.40],
                 [-0.55, -0.30], [-0.60, -0.55], [-0.45, -0.95], [-0.30, -0.70],
                 [-0.10, -0.95], [0.05, -0.70], [0.30, -0.85], [0.40, -0.50],
                 [0.55, -0.65], [0.65, -0.40], [0.70, -0.22], [0.92, -0.20]],
    // Predator carrier — barbed prow, stepped clawed flanks, recessed
    // hangar maw aft.
    carrier:    [[1.00,0.12],[0.80,0.32],[0.50,0.38],[0.55,0.55],[0.25,0.58],[0.18,0.40],
                 [-0.30,0.46],[-0.40,0.66],[-0.65,0.60],[-0.70,0.36],[-0.95,0.40],[-1.00,0.18],[-0.88,0.06],
                 [-0.88,-0.06],[-1.00,-0.18],[-0.95,-0.40],[-0.70,-0.36],[-0.65,-0.60],[-0.40,-0.66],
                 [-0.30,-0.46],[0.18,-0.40],[0.25,-0.58],[0.55,-0.55],[0.50,-0.38],[0.80,-0.32],[1.00,-0.12]],
    // 8-point spiked star — bristling carapace.
    station:    [[1.0, 0.0], [0.45, 0.45], [0.0, 1.0], [-0.45, 0.45],
                 [-1.0, 0.0], [-0.45, -0.45], [0.0, -1.0], [0.45, -0.45]],
  },
  hegemony: {
    // Armoured striker — chamfered ram prow, stepped armour plates
    // along the shoulders, short stub wings with cannon blisters,
    // boxed engine block aft. Heavy and angular, but no longer wide.
    fighter:    [[1.00, 0.00], [0.86, 0.10], [0.72, 0.10], [0.62, 0.22],
                 [0.42, 0.22], [0.30, 0.32], [0.10, 0.34], [-0.05, 0.48],
                 [-0.22, 0.50], [-0.30, 0.32], [-0.45, 0.34], [-0.55, 0.50],
                 [-0.78, 0.46], [-0.82, 0.24], [-0.95, 0.18], [-0.88, 0.06],
                 [-0.88, -0.06], [-0.95, -0.18], [-0.82, -0.24], [-0.78, -0.46],
                 [-0.55, -0.50], [-0.45, -0.34], [-0.30, -0.32], [-0.22, -0.50],
                 [-0.05, -0.48], [0.10, -0.34], [0.30, -0.32], [0.42, -0.22],
                 [0.62, -0.22], [0.72, -0.10], [0.86, -0.10]],
    // Heavy assault bomber — broad armoured prow, stepped bomb-bay
    // shoulders, weapon-pod wings, twin engine block. Still heavy —
    // the Hegemony read — but proportional, not a fortress at full
    // span.
    bomber:     [[1.00, 0.00], [0.90, 0.14], [0.76, 0.14], [0.66, 0.28],
                 [0.48, 0.30], [0.36, 0.46], [0.16, 0.50], [0.02, 0.62],
                 [-0.20, 0.64], [-0.28, 0.44], [-0.45, 0.46], [-0.55, 0.62],
                 [-0.80, 0.58], [-0.86, 0.34], [-1.00, 0.26], [-0.92, 0.08],
                 [-0.92, -0.08], [-1.00, -0.26], [-0.86, -0.34], [-0.80, -0.58],
                 [-0.55, -0.62], [-0.45, -0.46], [-0.28, -0.44], [-0.20, -0.64],
                 [0.02, -0.62], [0.16, -0.50], [0.36, -0.46], [0.48, -0.30],
                 [0.66, -0.28], [0.76, -0.14], [0.90, -0.14]],
    // Armoured escort — stepped hull with side turret blisters + engine
    // block. A boxy warship with layered plating, not a plain rectangle.
    frigate:    [[1.00,0.00],[0.84,0.18],[0.68,0.22],[0.62,0.40],[0.40,0.42],[0.34,0.26],
                 [0.05,0.30],[0.00,0.52],[-0.30,0.54],[-0.36,0.34],[-0.60,0.38],[-0.66,0.56],
                 [-0.88,0.52],[-0.94,0.26],[-0.84,0.08],[-1.00,0.06],
                 [-1.00,-0.06],[-0.84,-0.08],[-0.94,-0.26],[-0.88,-0.52],[-0.66,-0.56],[-0.60,-0.38],
                 [-0.36,-0.34],[-0.30,-0.54],[0.00,-0.52],[0.05,-0.30],[0.34,-0.26],[0.40,-0.42],
                 [0.62,-0.40],[0.68,-0.22],[0.84,-0.18]],
    // Armored slab cruiser: chamfered bow, forward citadel block,
    // wider mid-armor, stepped aft. Reads as a moving wall.
    cruiser:    [[1.0,  0.05], [0.85, 0.30], [0.65, 0.35], [0.60, 0.55],
                 [0.40, 0.60], [0.35, 0.80], [0.10, 0.85], [-0.15, 0.95],
                 [-0.45, 0.95], [-0.55, 0.80], [-0.75, 0.75], [-0.85, 0.55],
                 [-1.0,  0.50], [-1.0, -0.50], [-0.85, -0.55], [-0.75, -0.75],
                 [-0.55, -0.80], [-0.45, -0.95], [-0.15, -0.95], [0.10, -0.85],
                 [0.35, -0.80], [0.40, -0.60], [0.60, -0.55], [0.65, -0.35],
                 [0.85, -0.30], [1.0, -0.05]],
    // Fortress dreadnought: stacked terraces from bow to amidships,
    // peak mid-armor citadel, stepped armored aft. Heavy-as-hell read.
    battleship: [[1.0,  0.10], [0.92, 0.30], [0.85, 0.50], [0.70, 0.55],
                 [0.65, 0.75], [0.45, 0.80], [0.40, 0.95], [-0.20, 0.95],
                 [-0.25, 0.85], [-0.50, 0.95], [-0.70, 0.85], [-0.80, 0.70],
                 [-0.95, 0.60], [-1.0,  0.40], [-1.0, -0.40], [-0.95, -0.60],
                 [-0.80, -0.70], [-0.70, -0.85], [-0.50, -0.95], [-0.25, -0.85],
                 [-0.20, -0.95], [0.40, -0.95], [0.45, -0.80], [0.65, -0.75],
                 [0.70, -0.55], [0.85, -0.50], [0.92, -0.30], [1.0, -0.10]],
    // Armoured fleet carrier — broad slab with stepped deck blisters fore
    // and aft + a flat engine wall. Heavy and industrial.
    carrier:    [[1.00,0.20],[0.92,0.42],[0.60,0.46],[0.55,0.64],[0.25,0.66],[0.20,0.46],
                 [-0.55,0.48],[-0.60,0.66],[-0.85,0.64],[-0.90,0.40],[-1.00,0.34],[-1.00,0.14],
                 [-1.00,-0.14],[-1.00,-0.34],[-0.90,-0.40],[-0.85,-0.64],[-0.60,-0.66],[-0.55,-0.48],
                 [0.20,-0.46],[0.25,-0.66],[0.55,-0.64],[0.60,-0.46],[0.92,-0.42],[1.00,-0.20]],
    // Star-fort bastion — a cross of projecting gun bastions with
    // recessed curtain walls between. A fortress, not a chamfered box.
    station:    [[1.00,0.30],[0.70,0.30],[0.70,0.70],[0.30,0.70],[0.30,1.00],[-0.30,1.00],
                 [-0.30,0.70],[-0.70,0.70],[-0.70,0.30],[-1.00,0.30],
                 [-1.00,-0.30],[-0.70,-0.30],[-0.70,-0.70],[-0.30,-0.70],[-0.30,-1.00],[0.30,-1.00],
                 [0.30,-0.70],[0.70,-0.70],[0.70,-0.30],[1.00,-0.30]],
  },
  thren: {
    // Bio-organic manta — slim chitin prow, fluid swept wings tapering
    // to claw tips, narrow muscular body, forked tail vanes. Reads as
    // a predator, no longer a teardrop.
    fighter:    [[1.00, 0.00], [0.78, 0.06], [0.58, 0.08], [0.36, 0.10],
                 [0.18, 0.18], [0.00, 0.38], [-0.18, 0.50], [-0.32, 0.40],
                 [-0.30, 0.22], [-0.50, 0.28], [-0.62, 0.42], [-0.78, 0.22],
                 [-0.62, 0.08], [-0.80, 0.04], [-0.66, 0.00], [-0.80, -0.04],
                 [-0.62, -0.08], [-0.78, -0.22], [-0.62, -0.42], [-0.50, -0.28],
                 [-0.30, -0.22], [-0.32, -0.40], [-0.18, -0.50], [0.00, -0.38],
                 [0.18, -0.18], [0.36, -0.10], [0.58, -0.08], [0.78, -0.06]],
    // Bio-bomber — stinger prow, muscular shoulder bulges (the egg-sac
    // identity, but pulled inward), swept ray-wings, tapered tail
    // tendrils. Still organic, no longer a sphere.
    bomber:     [[1.00, 0.00], [0.82, 0.08], [0.60, 0.12], [0.42, 0.20],
                 [0.22, 0.32], [0.04, 0.50], [-0.18, 0.62], [-0.36, 0.54],
                 [-0.34, 0.30], [-0.55, 0.36], [-0.70, 0.54], [-0.86, 0.32],
                 [-0.74, 0.12], [-0.95, 0.10], [-0.78, 0.00], [-0.95, -0.10],
                 [-0.74, -0.12], [-0.86, -0.32], [-0.70, -0.54], [-0.55, -0.36],
                 [-0.34, -0.30], [-0.36, -0.54], [-0.18, -0.62], [0.04, -0.50],
                 [0.22, -0.32], [0.42, -0.20], [0.60, -0.12], [0.82, -0.08]],
    // No frigate/cruiser/battleship hulls — Thren doesn't field them.
    // Fallback in getHull catches the unused class via terran defaults.
    // Bio-organic mothership: elongated ~1.5:1 carrier proportions.
    // Stinger bow for the spinal cannon, swollen midsection bio-bays
    // with organic outward bulges, tapering stern. Max y ≈ 0.68 so
    // the silhouette reads as a proper capital ship, not a sphere.
    carrier:    [[1.0, 0.06], [0.94, 0.22], [0.78, 0.38], [0.55, 0.52],
                 [0.28, 0.62], [0.00, 0.66], [-0.22, 0.60], [-0.40, 0.68],
                 [-0.60, 0.60], [-0.78, 0.46], [-0.94, 0.28], [-1.0, 0.10],
                 [-1.0, -0.10], [-0.94, -0.28], [-0.78, -0.46], [-0.60, -0.60],
                 [-0.40, -0.68], [-0.22, -0.60], [0.00, -0.66], [0.28, -0.62],
                 [0.55, -0.52], [0.78, -0.38], [0.94, -0.22], [1.0, -0.06]],
    // Sphere-ish station node with curved indentations — alien hive.
    station:    [[1.0, 0.20], [0.85, 0.55], [0.55, 0.85], [0.20, 1.0],
                 [-0.20, 1.0], [-0.55, 0.85], [-0.85, 0.55], [-1.0, 0.20],
                 [-1.0, -0.20], [-0.85, -0.55], [-0.55, -0.85], [-0.20, -1.0],
                 [0.20, -1.0], [0.55, -0.85], [0.85, -0.55], [1.0, -0.20]],
  },
  voidsworn: {
    // Needle interceptor — long spear prow, slender body, sharply
    // swept manta wings tapering to fine tips, forked exhaust prongs.
    // The signature sleek silhouette, tightened further.
    fighter:    [[1.00, 0.00], [0.75, 0.03], [0.50, 0.06], [0.28, 0.10],
                 [0.05, 0.16], [-0.10, 0.34], [-0.24, 0.50], [-0.36, 0.40],
                 [-0.30, 0.22], [-0.46, 0.24], [-0.60, 0.36], [-0.72, 0.18],
                 [-0.60, 0.08], [-0.92, 0.10], [-0.78, 0.04], [-1.00, 0.03],
                 [-0.84, 0.00], [-1.00, -0.03], [-0.78, -0.04], [-0.92, -0.10],
                 [-0.60, -0.08], [-0.72, -0.18], [-0.60, -0.36], [-0.46, -0.24],
                 [-0.30, -0.22], [-0.36, -0.40], [-0.24, -0.50], [-0.10, -0.34],
                 [0.05, -0.16], [0.28, -0.10], [0.50, -0.06], [0.75, -0.03]],
    // Crescent gunship — needle prow, longer manta sweep, twin
    // energy-emitter wingtip prongs, forked stern.
    bomber:     [[1.00, 0.00], [0.78, 0.05], [0.55, 0.10], [0.30, 0.18],
                 [0.10, 0.32], [-0.10, 0.52], [-0.28, 0.62], [-0.42, 0.50],
                 [-0.34, 0.30], [-0.52, 0.32], [-0.68, 0.50], [-0.82, 0.30],
                 [-0.66, 0.10], [-0.95, 0.12], [-0.80, 0.04], [-1.00, 0.04],
                 [-0.86, 0.00], [-1.00, -0.04], [-0.80, -0.04], [-0.95, -0.12],
                 [-0.66, -0.10], [-0.82, -0.30], [-0.68, -0.50], [-0.52, -0.32],
                 [-0.34, -0.30], [-0.42, -0.50], [-0.28, -0.62], [-0.10, -0.52],
                 [0.10, -0.32], [0.30, -0.18], [0.55, -0.10], [0.78, -0.05]],
    // Elegant escort — spear prow, swept body, forked dorsal tail.
    frigate:    [[1.00,0.00],[0.55,0.08],[0.35,0.22],[0.10,0.50],[-0.20,0.62],[-0.45,0.50],
                 [-0.40,0.26],[-0.62,0.30],[-0.70,0.48],[-0.90,0.30],[-0.72,0.10],[-0.95,0.05],[-0.72,0.00],
                 [-0.95,-0.05],[-0.72,-0.10],[-0.90,-0.30],[-0.70,-0.48],[-0.62,-0.30],[-0.40,-0.26],
                 [-0.45,-0.50],[-0.20,-0.62],[0.10,-0.50],[0.35,-0.22],[0.55,-0.08]],
    // Crescent cruiser: needle prow, sleek swept body, central spine
    // recess at the stern. The narrow-waist + dorsal sweep reads as a
    // graceful predator.
    cruiser:    [[1.0,  0.00], [0.85, 0.12], [0.65, 0.30], [0.45, 0.55],
                 [0.15, 0.78], [-0.15, 0.95], [-0.45, 0.95], [-0.70, 0.80],
                 [-0.85, 0.55], [-0.95, 0.30], [-0.75, 0.15], [-0.95, 0.00],
                 [-0.75, -0.15], [-0.95, -0.30], [-0.85, -0.55], [-0.70, -0.80],
                 [-0.45, -0.95], [-0.15, -0.95], [0.15, -0.78], [0.45, -0.55],
                 [0.65, -0.30], [0.85, -0.12]],
    // Swept-wing battleship: extreme wing sweep, central spine
    // forks aft, needle prow. Looks alien-elegant and large.
    battleship: [[1.0,  0.00], [0.90, 0.18], [0.72, 0.30], [0.50, 0.55],
                 [0.30, 0.75], [0.00, 0.95], [-0.30, 0.95], [-0.55, 0.85],
                 [-0.75, 0.65], [-0.95, 0.45], [-1.0,  0.25], [-0.70, 0.20],
                 [-0.85, 0.05], [-1.0,  0.00], [-0.85, -0.05], [-0.70, -0.20],
                 [-1.0, -0.25], [-0.95, -0.45], [-0.75, -0.65], [-0.55, -0.85],
                 [-0.30, -0.95], [0.00, -0.95], [0.30, -0.75], [0.50, -0.55],
                 [0.72, -0.30], [0.90, -0.18]],
    // Long crescent carrier — spear prow, swept flight body, central
    // spine recess at the stern.
    carrier:    [[1.00,0.18],[0.70,0.30],[0.40,0.42],[0.05,0.55],[-0.35,0.62],[-0.65,0.55],
                 [-0.72,0.34],[-0.92,0.40],[-1.00,0.20],[-0.82,0.06],
                 [-0.82,-0.06],[-1.00,-0.20],[-0.92,-0.40],[-0.72,-0.34],[-0.65,-0.55],[-0.35,-0.62],
                 [0.05,-0.55],[0.40,-0.42],[0.70,-0.30],[1.00,-0.18]],
    // Rune-cut hexagon — clean outer hex with bevelled inner mouths.
    station:    [[1.0, 0.0], [0.7, 0.5], [0.35, 0.5], [0.0, 1.0],
                 [-0.35, 0.5], [-0.7, 0.5], [-1.0, 0.0], [-0.7, -0.5],
                 [-0.35, -0.5], [0.0, -1.0], [0.35, -0.5], [0.7, -0.5]],
  },
};

export function getHull(race, klass) {
  return (HULLS[race] && HULLS[race][klass]) || HULLS.terran[klass];
}

export { HULLS };

export function createShip({ klass, race = "terran", side, pos, heading = 0, controller, specOverride = null, initialHpFrac = 1, boons = null, fleetTraits = null, design = null }) {
  let spec = resolveSpec(race, klass);
  if (specOverride) spec = deepMerge(spec, specOverride);
  // Boon patches — declarative per-class spec mutations defined in
  // roguelite.js#BOON_EFFECTS. Side-by-side with specOverride
  // (perks + traits): boons stack onto the already-overridden spec.
  if (boons && boons.length > 0) {
    spec = applyBoonPatches(spec, boons, klass);
  }
  // Fleet-wide trait patches (e.g. Drill Sergeant's carrier
  // replenish). Same machinery as boon patches but keyed off the
  // run's owned traits via TRAIT_FLEET_EFFECTS.
  if (fleetTraits && fleetTraits.length > 0) {
    spec = applyTraitFleetPatches(spec, fleetTraits, klass);
  }
  // Persistent player-ship design — applied last so component patches
  // override race + boon + trait defaults. Only the player ship has a
  // design today; AI ships pass null and the spec is unchanged.
  if (design) {
    spec = applyDesign(spec, design);
  }
  // Roguelite wounded-spawn: a capital that came out of the previous
  // battle at 42% hull spawns at 42% hull here. Shields/armor still
  // reset to max each match (their state isn't legible-to-the-player
  // mid-fight and persistence would only confuse readouts).
  const hpFrac = initialHpFrac > 0 && initialHpFrac <= 1 ? initialHpFrac : 1;
  // Per-pod spec mapping — flattens spec.missilePods (single or array)
  // into a per-pod array so updateMissilePodFire can read each pod's
  // own spec for damage / cooldown / cluster behaviour. Capital
  // multi-slot designs (BB / carrier with 2 missile slots equipped
  // differently) produce 2+ groups; legacy single-group hulls produce
  // 1 group repeated `count` times.
  const podSpecsList = flattenMissilePods(spec.missilePods);

  // Default surrender thresholds.
  //   Capitals: strike colors when DISARMED (≥75% weapons gone) OR
  //     CRIPPLED-AND-CORNERED (≥50% engines gone AND hull ≤35%). The
  //     `hullThreshold` gate is what stops a healthy, still-firing capital
  //     from auto-surrendering the instant its engines are shot out — an
  //     immobilized warship with guns and hull keeps fighting as a
  //     stationary gun platform. Player captures surrendered enemies on a
  //     win; friendly capitals keep their flag on win.
  //   Small craft (fighter / bomber): ENGINE-ONLY trigger (no
  //     `hullThreshold`, so the engine path fires unconditionally). Weapon
  //     threshold > 1.0 so losing the single gun doesn't surrender (small
  //     craft are short-range — losing the gun is already death-adjacent).
  //     Engine threshold 0.5: one engine, so any engine loss trips it.
  //   Captain trait `neverSurrender` overrides everything — see updateShip.
  if (!spec.surrender) {
    if (klass === "frigate" || klass === "cruiser" || klass === "battleship" || klass === "carrier") {
      spec.surrender = { weaponThreshold: 0.75, engineThreshold: 0.5, hullThreshold: 0.35 };
    } else if (klass === "fighter" || klass === "bomber") {
      spec.surrender = { weaponThreshold: 999, engineThreshold: 0.5 };
    }
  }

  // Default boost block by class so any player hull can boost. The
  // fighter spec in classes.js carries an explicit block — that wins
  // when present (deep-merged through resolveSpec). Capitals get a
  // sprint-style boost (smaller speedMul, longer drain) so the
  // capital-sized player ship still feels heavy.
  if (!spec.boost) {
    const BOOST_DEFAULTS = {
      fighter:    { maxCharge: 3.0, drainRate: 1.0, rechargeRate: 0.6, rechargeDelay: 0.4, speedMul: 1.55, accelMul: 1.75 },
      bomber:     { maxCharge: 3.5, drainRate: 1.0, rechargeRate: 0.5, rechargeDelay: 0.5, speedMul: 1.45, accelMul: 1.50 },
      frigate:    { maxCharge: 4.0, drainRate: 1.0, rechargeRate: 0.5, rechargeDelay: 0.5, speedMul: 1.40, accelMul: 1.40 },
      cruiser:    { maxCharge: 5.0, drainRate: 1.0, rechargeRate: 0.4, rechargeDelay: 0.6, speedMul: 1.35, accelMul: 1.35 },
      battleship: { maxCharge: 6.0, drainRate: 1.0, rechargeRate: 0.35, rechargeDelay: 0.8, speedMul: 1.30, accelMul: 1.30 },
      carrier:    { maxCharge: 6.0, drainRate: 1.0, rechargeRate: 0.35, rechargeDelay: 0.8, speedMul: 1.30, accelMul: 1.30 },
    };
    if (BOOST_DEFAULTS[klass]) {
      // Clone so per-instance mutations (future engine-upgrade boon)
      // don't bleed into other ships sharing the resolved race spec.
      spec.boost = { ...BOOST_DEFAULTS[klass] };
    }
  }
  const ship = {
    id: nextId++,
    klass,
    race,
    side,
    spec,
    pos: { ...pos },
    vel: { x: 0, y: 0 },
    heading,
    hp: spec.hp * hpFrac,
    hpMax: spec.hp,
    cooldown: 0,           // forward firing
    cooldownPort: 0,       // broadside: left side
    cooldownStarboard: 0,  // broadside: right side
    // Multi-stage salvo state. Only consulted when spec.weapon.salvo is
    // defined. Each shot in a salvo fires at the ship's *current* aim,
    // so a moving target gets traced through the burst. Salvo continues
    // independently of controller.firing — once committed, the volley
    // lands in full.
    salvoShotsLeft: 0,
    salvoShotTimer: 0,
    salvoPortShotsLeft: 0,
    salvoPortShotTimer: 0,
    salvoStbdShotsLeft: 0,
    salvoStbdShotTimer: 0,
    controller, // mutable: { thrust, aim, firing, firingMissile }
    dead: false,
    isPlayer: false,
    // Shield (always present; 0 if class has no shield spec).
    shield: spec.shield ? spec.shield.max : 0,
    shieldMax: spec.shield ? spec.shield.max : 0,
    shieldBaseMax: spec.shield ? spec.shield.max : 0, // immutable baseline; scaled by generators
    shieldHitTimer: 0, // counts up since last hit; regen kicks in past regenDelay
    shieldFlash: 0,    // visual: brief brighten when hit
    shieldHits: [],    // localized arc flares from recent absorbs
    // Ship-level armor REMOVED. Armor is now per-block + per-module
    // (each cell.armor / module.armor field is a 0..1 reduction
    // applied at damage time). spec.armor entries in classes.js are
    // inert relics — kept to avoid touching the spec tree, but no
    // longer read.
    // Persistent battle damage marks, painted on top of the hull sprite.
    // Each entry: { lx, ly, size, kind: "armor-flake" | "hull-hole", seed }.
    // Positions are in ship-local (world units), so they rotate with the
    // ship. Sustained fire on the same spot grows an existing scar instead
    // of stacking new ones (see addImpactScar in game.js).
    scars: [],
    // Missile state (single-shot weapons like the fighter's missile).
    missileCd: 0,
    aiMissileCd: 0,
    // Boost state. Player-driven only — AI controllers never set the
    // boost flag, so AI ships keep their full charge but never spend
    // it. Charge full at spawn so a fresh respawn has the boost ready.
    boostCharge: spec.boost ? spec.boost.maxCharge : 0,
    boostMax:    spec.boost ? spec.boost.maxCharge : 0,
    boostActive: false,
    boostCooldownTimer: 0,
    // Surrender state. Set true by the surrender check in updateShip
    // when module losses cross the spec.surrender thresholds. Once
    // surrendered, the ship stops firing + drifts + becomes untargetable.
    // captureBattleOutcome reads this at match-end to capture enemy
    // surrenders into the player's fleet (Frontier mode).
    surrendered: false,
    surrenderedAt: 0,
    // PD turret cooldowns (one per turret).
    pdCooldowns: spec.pdCannons ? new Array(spec.pdCannons.count).fill(0) : null,
    // Ring-cannon cooldowns (frigates have 4 mounts firing independently).
    ringCooldowns: spec.ringCannons ? new Array(spec.ringCannons.count).fill(0) : null,
    // Missile pod cooldowns + per-pod spec mapping. podSpecs may have
    // mixed entries (e.g. pods 0..2 are cluster pods, pods 3..4 are
    // nukes) when the player has equipped two different missile
    // components in capital missile slots. One cooldown per pod;
    // updateMissilePodFire reads podSpecs[i] per pod.
    podSpecs: podSpecsList,
    podCooldowns: podSpecsList ? new Array(podSpecsList.length).fill(0) : null,
    // Heavy laser per-mount specs + cooldowns. Flattened from
    // spec.heavyLaser (single or array). Two-Particle-Cannon BB
    // designs produce 2 entries firing independently. Legacy single
    // beam still produces a 1-entry array. `laserCd` kept as alias
    // for laserCooldowns[0] so any external code reading the legacy
    // field still works.
    laserSpecs: null,    // sized below
    laserCooldowns: null,
    // Per-laser aim-tracking angles for the barrel render path. One
    // angle per beam; render iterates and draws each barrel.
    laserAimAngles: null,
    // Legacy fields — populated as aliases of the first laser's
    // values so any external code still reading these doesn't break.
    laserCd: 0,
    // Cannon magazine (only used when spec.weapon.capacity is set).
    weaponAmmo: spec.weapon && spec.weapon.capacity ? spec.weapon.capacity : 0,
    weaponReloading: false,
    weaponReloadTimer: 0,
    // Cruiser forward cannons turret-track instead of being nailed to
    // the bow. World-space angle, slewed each frame in updateShip
    // toward the controller's c.aim direction (capped at
    // spec.cannonTurnRate). drawShip rotates the visible barrels onto
    // this angle, fireForward fires projectiles along it. Defaults to
    // the spawn heading so the first frame doesn't look weird.
    // Bow-mounted turret tracking — used by cruisers and the Thren
    // carrier (any class that fires forward AND wants the cannon to
    // sweep independently of the hull heading). Other forward-firing
    // classes (fighter/bomber) keep cannonAimAngle === null and use
    // nose-locked aim.
    cannonAimAngle: ((klass === "cruiser" || klass === "carrier") && spec.firingMode === "forward") ? heading : null,
    // Carrier replenishment cadence — counts down to the next launch.
    fighterLaunchCd: spec.replenish ? spec.replenish.fighter : 0,
    bomberLaunchCd: spec.replenish ? spec.replenish.bomber : 0,
    // Player cosmetic paint, read by drawShip when set. AI ships pass
    // null (no design) so this is null for them. Trim is optional —
    // primary alone applies a hull tint; trim adds an outline stroke.
    paint: (design && (design.paintPrimary || design.paintTrim))
      ? { primary: design.paintPrimary || null, trim: design.paintTrim || null }
      : null,
    // Capital subsystem modules: nullable list of destructible parts.
    // Populated for battleship / carrier / cruiser; other classes stay null
    // and route damage straight to hull as before.
    modules: buildModules(klass, spec, getHull(race, klass),
                          (getCellStats(race, klass) || {}).armor || 0),
    moduleByName: null,
    pdTurretModules: null,
    podModules: null,
  };
  // Set up per-mount heavy laser state. Single-beam ships get a
  // 1-entry array; multi-beam designs (2× Particle Cannon BB) get
  // N entries. Each runs its own cooldown + aim angle.
  if (spec.heavyLaser) {
    ship.laserSpecs = flattenHeavyLasers(spec.heavyLaser);
    if (ship.laserSpecs) {
      ship.laserCooldowns = new Array(ship.laserSpecs.length).fill(0);
      ship.laserAimAngles = new Array(ship.laserSpecs.length).fill(null);
    }
  }
  // Per-mount primary weapons. spec.weapon is always the single primary
  // (so all external code reading spec.weapon.damage etc. still works);
  // additional weapons live on spec.weaponExtras[] for multi-mount BB
  // designs. createShip combines them into ship.weapons[] with one
  // state object per weapon. Each weapon carries its own firingMode —
  // multi-mount designs stamp it via applyDesign; legacy single-weapon
  // ships inherit from spec.firingMode.
  if (spec.weapon) {
    const allWeaponSpecs = [spec.weapon].concat(spec.weaponExtras || []);
    const weaponSpecs = allWeaponSpecs
      .filter((w) => w && typeof w.damage === "number" && w.damage > 0)
      .map((w) => (w.firingMode ? w : { ...w, firingMode: spec.firingMode || "forward" }));
    if (weaponSpecs && weaponSpecs.length > 0) {
      ship.weapons = weaponSpecs.map((ws) => {
        const w = makeWeaponState(ws, heading);
        // Cannon-aim init: same rule as the legacy ship.cannonAimAngle —
        // tracking only for forward-firing cruisers + carriers (where
        // the bow turret slews independently of the hull). Other forward
        // classes (fighter/bomber) keep cannonAimAngle null and use
        // nose-locked aim.
        if ((klass === "cruiser" || klass === "carrier") && ws.firingMode === "forward") {
          w.cannonAimAngle = heading;
        }
        return w;
      });
      // Legacy aliases — keep ship.cooldown / ship.weaponAmmo / etc.
      // pointing at weapons[0] so external readers (game.js, hud.js,
      // ai.js) keep working.
      const w0 = ship.weapons[0];
      ship.cooldown = w0.cooldown;
      ship.cooldownPort = w0.cooldownPort;
      ship.cooldownStarboard = w0.cooldownStarboard;
      ship.salvoShotsLeft = w0.salvoShotsLeft;
      ship.salvoShotTimer = w0.salvoShotTimer;
      ship.salvoPortShotsLeft = w0.salvoPortShotsLeft;
      ship.salvoPortShotTimer = w0.salvoPortShotTimer;
      ship.salvoStbdShotsLeft = w0.salvoStbdShotsLeft;
      ship.salvoStbdShotTimer = w0.salvoStbdShotTimer;
      ship.weaponAmmo = w0.weaponAmmo;
      ship.weaponReloading = w0.weaponReloading;
      ship.weaponReloadTimer = w0.weaponReloadTimer;
      if (w0.cannonAimAngle != null) ship.cannonAimAngle = w0.cannonAimAngle;
    }
  }
  if (ship.modules) {
    ship.moduleByName = {};
    for (const m of ship.modules) ship.moduleByName[m.name] = m;
    // Pre-compute per-turret and per-pod module lookups so subsystem
    // updates don't have to map angles → modules every tick.
    if (spec.pdCannons) {
      const n = spec.pdCannons.count;
      ship.pdTurretModules = new Array(n);
      for (let i = 0; i < n; i++) {
        ship.pdTurretModules[i] = pdTurretToModuleName(klass, i, n);
      }
    }
    if (podSpecsList) {
      // Per-pod module mapping. Two paths:
      //   (a) Multi-group capital design (BB/carrier with 2 missile slots
      //       equipped with different components) — each group routes to
      //       its own bay so partial destruction is possible (kill the
      //       fore bay, lose only the cluster pods; aft bay's nukes
      //       keep firing).
      //   (b) Legacy single-group — fall back to the index-based
      //       podToModuleName helper.
      // Detection: count unique spec refs in podSpecsList. >1 → multi-group.
      const n = podSpecsList.length;
      ship.podModules = new Array(n);
      const uniqueGroups = new Set(podSpecsList);
      const multiGroup = uniqueGroups.size > 1;
      if (multiGroup && (klass === "carrier" || klass === "battleship")) {
        // Track group index by counting spec-ref transitions in order
        // (podSpecsList preserves group order because flattenMissilePods
        // emits each group's pods sequentially).
        let groupIdx = 0;
        let lastSpec = podSpecsList[0];
        const foreBay = klass === "battleship" ? "missile-fwd" : "missile-bay-fore";
        const aftBay  = klass === "battleship" ? "missile-aft" : "missile-bay-aft";
        for (let i = 0; i < n; i++) {
          if (podSpecsList[i] !== lastSpec) {
            groupIdx++;
            lastSpec = podSpecsList[i];
          }
          // Group 0 → fore bay; any additional group → aft bay. With
          // exactly 2 groups (current Phase B max) this is a clean split.
          ship.podModules[i] = groupIdx === 0 ? foreBay : aftBay;
        }
      } else {
        for (let i = 0; i < n; i++) {
          ship.podModules[i] = podToModuleName(klass, i, n);
        }
      }
    }
  }

  // Torpedo tubes (battleship). Two ports, each on its own cooldown.
  if (spec.torpedoes) {
    const tc = spec.torpedoes.count || 2;
    ship.torpedoCooldowns = new Array(tc).fill(0);
    ship.torpedoModules = [];
    for (let i = 0; i < tc; i++) {
      ship.torpedoModules.push(i % 2 === 0 ? "torpedo-tube-port" : "torpedo-tube-stbd");
    }
  }

  // Destructible cell overlay. Each cell sits in ship-local space and
  // dies in one or two hits within a damage-scaled radius (see
  // damageCellsInRadius in sprites.js / applyDamage in game.js). Cells
  // are bound to the nearest module so a module kill tears out a
  // matching cluster of pixels along with it.
  const grid = buildCells(klass, spec.radius, ship.race);
  if (grid) {
    ship.cells      = grid.cells;
    ship.cellW      = grid.cellW;
    ship.cellH      = grid.cellH;
    ship.cols       = grid.cols;
    ship.rows       = grid.rows;
    ship.cellHalfX  = grid.halfX;
    ship.cellHalfY  = grid.halfY;
    ship.cellHpMax  = grid.cellHpMax;
    ship.cellHullCost = grid.cellHullCost;
    ship.cellArmor  = grid.cellArmor;
    ship.coreCell   = grid.coreCell || null;
    ship.blockCanvas = null;
    ship.blockDirty  = true;  // build canvas on first draw
    ship.deadCells = [];
    // Snapshot live cell count at spawn for block-loss % calculations.
    ship.totalLiveCells = grid.cells.filter(c => !c.culled).length;
    if (ship.modules) {
      // Snap every module onto a live block, ENFORCING port↔starboard mirror
      // symmetry (weapons + PD read symmetric). Module offsets are fixed
      // per-class fractions (modules.js) but the silhouette varies per race,
      // so some land over culled void — engine nozzles behind a tapered
      // stern, a forward broadside off the narrowing bow, a fighter gun on a
      // needle prow. snapModulesSymmetric pairs off-axis modules, pins
      // centreline ones to the axis, and snaps each pair as a mirror so they
      // rest on structure AND stay symmetric. PD fire reads pdTurretOffset
      // (the module offset) so firing origins follow; broadside muzzles read
      // offset.x for their lengthwise position, nudged only when off-hull.
      snapModulesSymmetric(grid, spec.radius, ship.modules);
      // For each module, bind every still-unbound live cell whose centre
      // sits inside the module's disc to that module. Multiple discs may
      // overlap; the first-touch-wins assignment keeps the binding
      // deterministic and means engines (added late by buildModules) don't
      // steal weapon-cluster cells.
      for (const m of ship.modules) {
        const mx = m.offset.x * spec.radius;
        const my = m.offset.y * spec.radius;
        const mr = m.radius * spec.radius;
        const mr2 = mr * mr;
        for (const cell of ship.cells) {
          if (cell.culled || cell.dead || cell.moduleName) continue;
          const dx = cell.lx - mx;
          const dy = cell.ly - my;
          if (dx * dx + dy * dy <= mr2) {
            cell.moduleName = m.name;
          }
        }
      }
    }
    // Wounded carry-over — pre-damage cells to match the hull fraction so
    // the block grid visually reflects the ship's battle-scarred state
    // rather than appearing fully intact on a 50%-HP hull.
    if (hpFrac < 1) preDamageBlockGrid(ship, hpFrac);
  } else {
    ship.cells = null;
  }

  return ship;
}

// ---------------------------------------------------------------------------
// Per-tick ship update.
// ---------------------------------------------------------------------------
export function updateShip(ship, dt, world) {
  const s = ship.spec;
  const c = ship.controller;

  // Surrender check — capitals (ships with modules + a surrender spec)
  // strike colors when most of their weapons OR engines are gone. Once
  // surrendered, the ship drifts to a stop, AI stops firing, PD/aim
  // pickers skip it. Captain trait "neverSurrender" gates the check
  // off entirely. Idempotent — once surrendered stays surrendered.
  if (s.surrender && !ship.surrendered && ship.modules) {
    // Two gates: per-ship flag (boss/ace nodes set this so the
    // climactic encounter doesn't end with a whimper) AND the captain
    // trait ("never-surrender" stamps captain.neverSurrender).
    const neverSurrender = !!ship.neverSurrender ||
                            !!(ship.captain && ship.captain.neverSurrender);
    if (!neverSurrender) {
      const survey = moduleLossSurvey(ship);
      // Block loss fraction — ship must be structurally wrecked (≥65%
      // cells dead) in addition to losing weapons before it strikes.
      // This stops a single salvo wiping a lucky module from triggering
      // an immediate surrender on a mostly-intact hull.
      const blockLoss = (ship.totalLiveCells > 0 && ship.deadCells)
        ? ship.deadCells.length / ship.totalLiveCells : 0;
      const blockLossThreshold = s.surrender.blockLossThreshold != null
        ? s.surrender.blockLossThreshold : 0.65;
      // DISARMED: most weapons gone AND hull is heavily wrecked.
      const disarmed = survey.weaponLoss >= s.surrender.weaponThreshold
        && blockLoss >= blockLossThreshold;
      // IMMOBILIZED: engines gone. For capitals (hullThreshold set) this
      // only counts as a surrender trigger when the hull is ALSO critical
      // — an engine-killed but healthy, armed capital fights on. Small
      // craft (no hullThreshold) surrender on engine loss alone, as before.
      let immobilized = survey.engineLoss >= s.surrender.engineThreshold;
      if (immobilized && typeof s.surrender.hullThreshold === "number") {
        const hullFrac = ship.hpMax > 0 ? ship.hp / ship.hpMax : 1;
        immobilized = hullFrac <= s.surrender.hullThreshold;
      }
      if (disarmed || immobilized) {
        ship.surrendered = true;
        ship.surrenderedAt = (world && world.time) || 0;
        events.emit("shipSurrendered", {
          id: ship.id, klass: ship.klass, race: ship.race,
          side: ship.side, x: ship.pos.x, y: ship.pos.y,
          weaponLoss: survey.weaponLoss, engineLoss: survey.engineLoss,
        });
      }
    }

  }
  // Surrendered ships are inert: clear the controller so AI firing /
  // turret slew / movement intent all stop in this update. We don't
  // freeze position outright — let drag bleed velocity naturally so
  // the ship coasts to a stop instead of stopping on a dime.
  if (ship.surrendered) {
    // Override controller for this tick only — don't mutate the
    // controller object itself (some controllers are shared singletons).
    ship.vel.x *= Math.exp(-1.2 * dt);
    ship.vel.y *= Math.exp(-1.2 * dt);
    ship.pos.x += ship.vel.x * dt;
    ship.pos.y += ship.vel.y * dt;
    // Tick shield flash + scars even while surrendered so visual
    // ageing stays consistent.
    if (ship.shieldFlash > 0) ship.shieldFlash = Math.max(0, ship.shieldFlash - dt * 4);
    return;  // skip the entire normal update pipeline (firing, AI, etc)
  }

  // Engine module gating — each visible plume is its own targetable
  // module (engine-0 .. engine-N-1). Lose half your engines, fly at half
  // speed. Lose them all and the ship goes dead in the water (drifting
  // velocity exponentially decays).
  let aliveEngines = 0, totalEngines = 0;
  if (ship.modules) {
    for (const m of ship.modules) {
      if (m.name[0] === "e" && m.name.startsWith("engine")) {
        totalEngines++;
        if (!m.disabled) aliveEngines++;
      }
    }
  }
  const engineFrac = totalEngines > 0 ? aliveEngines / totalEngines : 1;
  const engineDead = totalEngines > 0 && aliveEngines === 0;

  // Speed boost — player holds the boost button to spend charge for a
  // burst of speed. Only consumed when (a) ship has a spec.boost block
  // AND (b) controller.boost is set (player ships only — AI controllers
  // never set this) AND (c) charge remaining. Drains while active;
  // recharges after a brief idle window. Audio + plume read
  // ship.boostActive for visual / SFX feedback.
  const boostSpec = s.boost;
  const wantBoost = boostSpec && c && c.boost && ship.boostCharge > 0 && !engineDead;
  ship.boostActive = !!wantBoost;
  if (boostSpec) {
    if (wantBoost) {
      ship.boostCharge = Math.max(0, ship.boostCharge - boostSpec.drainRate * dt);
      ship.boostCooldownTimer = 0;
    } else {
      ship.boostCooldownTimer += dt;
      if (ship.boostCooldownTimer >= boostSpec.rechargeDelay && ship.boostCharge < ship.boostMax) {
        ship.boostCharge = Math.min(ship.boostMax, ship.boostCharge + boostSpec.rechargeRate * dt);
      }
    }
  }
  const boostMul = (ship.boostActive && boostSpec) ? boostSpec.speedMul : 1.0;
  const effMaxSpeed = s.maxSpeed * engineFrac * boostMul;

  // Fighters and bombers use an aircraft flight model: velocity is locked
  // to nose direction at constant maxSpeed. They cannot strafe or
  // snap-turn — the only way to change direction is to bank (rotate
  // heading), which is turn-rate-limited.
  if (engineDead) {
    // Half-life ~0.45s — visibly drifts a beat, then stops.
    const decay = Math.exp(-1.5 * dt);
    ship.vel.x *= decay;
    ship.vel.y *= decay;
  } else if (ship.klass !== "station") {
    // Every combat ship — fighters, bombers, and now capitals — flies
    // at constant max speed in its heading direction. AIs steer
    // exclusively via c.aim; c.thrust is no longer consulted. This
    // unifies the movement model and makes capital paths much easier
    // to read on the minimap (no thrust-mediated jitter).
    ship.vel.x = Math.cos(ship.heading) * effMaxSpeed;
    ship.vel.y = Math.sin(ship.heading) * effMaxSpeed;
  } else {
    ship.vel.x = 0;
    ship.vel.y = 0;
  }

  ship.pos.x += ship.vel.x * dt;
  ship.pos.y += ship.vel.y * dt;

  // Arena bounds: clamp + zero velocity component into wall.
  const b = world.arena.bounds;
  if (ship.pos.x < b.minX + s.radius) { ship.pos.x = b.minX + s.radius; if (ship.vel.x < 0) ship.vel.x = 0; }
  if (ship.pos.x > b.maxX - s.radius) { ship.pos.x = b.maxX - s.radius; if (ship.vel.x > 0) ship.vel.x = 0; }
  if (ship.pos.y < b.minY + s.radius) { ship.pos.y = b.minY + s.radius; if (ship.vel.y < 0) ship.vel.y = 0; }
  if (ship.pos.y > b.maxY - s.radius) { ship.pos.y = b.maxY - s.radius; if (ship.vel.y > 0) ship.vel.y = 0; }

  // Rotate heading toward aim direction. Turn rate scales with the
  // fraction of engines still alive: lose half your engines, turn at
  // half speed. When every engine is gone we still allow 15% residual
  // RCS so the silhouette can slowly drift its attitude.
  if (c.aim && (c.aim.x !== 0 || c.aim.y !== 0)) {
    const target = V.angle(c.aim);
    const delta = V.angleDelta(ship.heading, target);
    const turnScale = engineDead ? 0.15 : Math.max(0.15, engineFrac);
    const step = Math.sign(delta) * Math.min(Math.abs(delta), s.turnRate * turnScale * dt);
    ship.heading += step;
  }

  // Shield generator state — each generator module lost halves shield
  // capacity (or takes it offline entirely on a single-generator hull).
  if (ship.shieldBaseMax > 0 && ship.modules) {
    let liveGens = 0, totalGens = 0;
    for (const m of ship.modules) {
      if (m.name.startsWith("shield-generator")) {
        totalGens++;
        if (!m.disabled) liveGens++;
      }
    }
    if (totalGens > 0) {
      ship.shieldMax = ship.shieldBaseMax * (liveGens / totalGens);
      if (ship.shield > ship.shieldMax) ship.shield = ship.shieldMax;
    }
  }

  // Shield regeneration: only after shieldRegenDelay seconds since last hit.
  if (s.shield) {
    ship.shieldHitTimer += dt;
    if (ship.shieldHitTimer >= s.shield.regenDelay && ship.shield < ship.shieldMax) {
      ship.shield = Math.min(ship.shieldMax, ship.shield + s.shield.regen * dt);
    }
  }
  if (ship.shieldFlash > 0) ship.shieldFlash = Math.max(0, ship.shieldFlash - dt * 4);
  // Tick down per-hit shield-arc flares — recorded in game.js
  // applyDamage when a shield absorbs a projectile. Each entry holds
  // an angle in ship-local space + a ttl; drop entries that age out
  // so the array stays bounded.
  if (ship.shieldHits && ship.shieldHits.length > 0) {
    for (let i = ship.shieldHits.length - 1; i >= 0; i--) {
      ship.shieldHits[i].ttl -= dt;
      if (ship.shieldHits[i].ttl <= 0) ship.shieldHits.splice(i, 1);
    }
  }
  if (ship.modules) {
    for (const m of ship.modules) {
      if (m.flash > 0) m.flash = Math.max(0, m.flash - dt * 4);
    }
  }

  // Primary weapon — per-mount iteration. ship.weapons is set up by
  // createShip from spec.weapon (single or array). Each weapon entry
  // carries its own firingMode + cooldowns + salvo + ammo + cannon-aim,
  // so a BB with 2× Bow Cannon (or Bow + Mass Driver) fires both
  // independently with their own cooldowns. Frigates with ring cannons
  // have firingMode "ring" — handled in the secondary subsystems block
  // alongside PD, not here.
  if (ship.weapons && ship.weapons.length > 0) {
    for (let wi = 0; wi < ship.weapons.length; wi++) {
      const w = ship.weapons[wi];
      const wMode = w.spec.firingMode;
      if (wMode === "broadside") {
        w.cooldownPort -= dt;
        w.cooldownStarboard -= dt;
        updateBroadsideFireForWeapon(ship, world, dt, w);
      } else if (wMode === "forward") {
        w.cooldown -= dt;
        // Cruiser / Thren-carrier turret-tracked cannons slew toward
        // the lead direction. Per-weapon aim angle so multi-cannon
        // BB designs each track their own commanded direction.
        if (w.cannonAimAngle != null) {
          slewCannonAimForWeapon(ship, dt, w);
        }
        updateForwardFireForWeapon(ship, world, dt, w, c);
      }
      // ring-cannon weapons handled below in the secondary subsystems block.
    }
    // Legacy alias sync — keep ship.cooldown / ship.weaponAmmo /
    // ship.cannonAimAngle in sync with weapons[0] for external readers
    // (game.js, hud.js, ai.js).
    const w0 = ship.weapons[0];
    ship.cooldown = w0.cooldown;
    ship.cooldownPort = w0.cooldownPort;
    ship.cooldownStarboard = w0.cooldownStarboard;
    ship.salvoShotsLeft = w0.salvoShotsLeft;
    ship.salvoShotTimer = w0.salvoShotTimer;
    ship.salvoPortShotsLeft = w0.salvoPortShotsLeft;
    ship.salvoPortShotTimer = w0.salvoPortShotTimer;
    ship.salvoStbdShotsLeft = w0.salvoStbdShotsLeft;
    ship.salvoStbdShotTimer = w0.salvoStbdShotTimer;
    ship.weaponAmmo = w0.weaponAmmo;
    ship.weaponReloading = w0.weaponReloading;
    ship.weaponReloadTimer = w0.weaponReloadTimer;
    if (w0.cannonAimAngle != null) ship.cannonAimAngle = w0.cannonAimAngle;
  }

  // Secondary subsystems.
  ship.missileCd = Math.max(0, ship.missileCd - dt);
  ship.aiMissileCd = Math.max(0, ship.aiMissileCd - dt);
  // Tick per-laser cooldowns (multi-beam BB designs). Keep ship.laserCd
  // in sync with laserCooldowns[0] as a legacy alias.
  if (ship.laserCooldowns) {
    for (let i = 0; i < ship.laserCooldowns.length; i++) {
      ship.laserCooldowns[i] = Math.max(0, ship.laserCooldowns[i] - dt);
    }
    ship.laserCd = ship.laserCooldowns[0];
  } else {
    ship.laserCd = Math.max(0, ship.laserCd - dt);
  }
  if (ship.pdCooldowns) {
    for (let i = 0; i < ship.pdCooldowns.length; i++) {
      ship.pdCooldowns[i] = Math.max(0, ship.pdCooldowns[i] - dt);
    }
  }
  if (ship.podCooldowns) {
    for (let i = 0; i < ship.podCooldowns.length; i++) {
      ship.podCooldowns[i] = Math.max(0, ship.podCooldowns[i] - dt);
    }
  }
  if (ship.ringCooldowns) {
    for (let i = 0; i < ship.ringCooldowns.length; i++) {
      ship.ringCooldowns[i] = Math.max(0, ship.ringCooldowns[i] - dt);
    }
  }

  // Fighter missile launch (player or AI). One-shot — flag is always
  // cleared after evaluation so a press while cooling isn't queued
  // indefinitely. Gated on the gun module's liveness so a fighter
  // with its bow weapons compartment destroyed can't fire missiles
  // either. (The fighter has a single bow armament module covering
  // both cannon and missile launcher; no separate missile module.)
  if (s.missile && c.firingMissile) {
    const gunMod = ship.moduleByName && ship.moduleByName.gun;
    const gunLive = !gunMod || !gunMod.disabled;
    if (gunLive && ship.missileCd <= 0) {
      fireFighterMissile(ship, world);
      ship.missileCd = s.missile.cooldown;
    }
    c.firingMissile = false;
  }

  // Capital ship subsystems.
  if (s.pdCannons) updatePDFire(ship, world);
  if (s.ringCannons) updateRingFire(ship, world);
  if (s.missilePods) updateMissilePodFire(ship, world);
  if (s.torpedoes) updateTorpedoFire(ship, world, dt);
  if (s.heavyLaser) updateHeavyLaser(ship, world);
  if (s.replenish) updateReplenishment(ship, dt, world);

  if (isShipDestroyed(ship)) ship.dead = true;
}

// Returns true when a ship should be removed from play. Ships with a
// destructible cell grid can only be killed by destroying their core block
// ("power unit") — hull HP erosion and module losses alone are not lethal.
// Ships without a cell grid fall back to the classic hp<=0 condition.
export function isShipDestroyed(ship) {
  if (ship.cells) return ship.coreCell ? ship.coreCell.dead : ship.hp <= 0;
  return ship.hp <= 0;
}

// ---------------------------------------------------------------------------
// Carrier replenishment: every spec.replenish.fighter seconds launch one
// fighter, every spec.replenish.bomber seconds launch one bomber. With the
// bomber cycle at 2x the fighter cycle, the launch ratio is 2:1.
// ---------------------------------------------------------------------------
function updateReplenishment(carrier, dt, world) {
  // A destroyed hangar freezes both production lines — the carrier's
  // strategic role ends without killing the ship.
  if (carrier.moduleByName && carrier.moduleByName.hangar && carrier.moduleByName.hangar.disabled) return;
  carrier.fighterLaunchCd -= dt;
  carrier.bomberLaunchCd -= dt;
  if (carrier.fighterLaunchCd <= 0) {
    launchReplacement(carrier, world, "fighter");
    carrier.fighterLaunchCd = carrier.spec.replenish.fighter;
  }
  if (carrier.bomberLaunchCd <= 0) {
    launchReplacement(carrier, world, "bomber");
    carrier.bomberLaunchCd = carrier.spec.replenish.bomber;
  }
}

function launchReplacement(carrier, world, klass) {
  const fwd = V.fromAngle(carrier.heading);
  const lateralVec = { x: -fwd.y, y: fwd.x };
  const lateralSign = Math.random() < 0.5 ? -1 : 1;
  const offset = carrier.spec.radius + 30;
  const lat = 30 + Math.random() * 60;
  const pos = {
    x: carrier.pos.x + fwd.x * offset + lateralVec.x * lateralSign * lat,
    y: carrier.pos.y + fwd.y * offset + lateralVec.y * lateralSign * lat,
  };
  const heading = carrier.heading + (Math.random() - 0.5) * 0.4;
  const ship = createShip({
    klass,
    race: carrier.race,
    side: carrier.side,
    pos,
    heading,
    controller: { thrust: { x: 0, y: 0 }, aim: null, firing: false, firingMissile: false },
    // Replenishment ships inherit the run's active boons + fleet
    // traits so a mid-battle carrier launch picks up tracer-rounds,
    // precog-targeting, drill-sergeant, etc. — same as the initial
    // spawn wave.
    boons: carrier.side === "blue" ? (world.activeBoons || null) : null,
    fleetTraits: carrier.side === "blue" ? (world.activeFleetTraits || null) : null,
  });
  world.ships.push(ship);
  // Carrier-launch SFX — short catapult thunk + thrust whoosh as the
  // new craft clears the bay. Position is the launch point, not the
  // carrier centre, so attenuation feels right when a far-away carrier
  // launches.
  events.emit("carrierLaunch", {
    x: pos.x, y: pos.y,
    klass,
    isPlayer: false, // carrier launches are never the player ship
  });
}

// ---------------------------------------------------------------------------
// Forward fire (fighters, frigates, cruisers). Cruiser cannons fire along
// `ship.cannonAimAngle` (a turret-tracked angle) rather than the ship's
// heading — the muzzle origin pivots about a bow turret base and extends
// along the cannon's aim, so the projectiles emerge from the visible
// barrel tips. Fighters/frigates keep the bow-locked path.
// ---------------------------------------------------------------------------
const CANNON_TURRET = {
  // Where the turret base sits on the hull (ship-local +x is forward).
  // Slightly back from the nose so the barrels have room to swing
  // without appearing detached at extreme aim angles.
  pivotR: 0.35,
  // Barrel length as a fraction of ship.radius — the projectile spawns
  // at the muzzle tip = pivot + aimDir * barrelLen.
  barrelLen: 0.72,
};

// Legacy fireForward — reads ship.spec.weapon + ship.cannonAimAngle.
// Kept as a wrapper around fireForwardWeapon so external callers (if
// any) still work.
function fireForward(ship, world) {
  // Build a synthetic weapon-state from the legacy single fields.
  const synth = {
    spec: ship.spec.weapon,
    cannonAimAngle: ship.cannonAimAngle,
  };
  fireForwardWeapon(ship, world, synth);
}

// Per-weapon forward fire — reads from a ship.weapons[i] entry. This is
// the new primary fire path; legacy fireForward is a wrapper.
function fireForwardWeapon(ship, world, weaponState) {
  const w = weaponState.spec;
  const muzzles = w.muzzles || 1;
  const muzzleSpread = w.muzzleSpread || 0;
  const isTracking = weaponState.cannonAimAngle != null;
  const aimAngle = isTracking ? weaponState.cannonAimAngle : ship.heading;
  const aimDir = V.fromAngle(aimAngle);
  const aimSide = { x: -aimDir.y, y: aimDir.x };

  // Turret-tracked classes spawn projectiles at the swung muzzle tip,
  // not the static bow. The pivot base sits on the hull in ship-local
  // frame; the barrels extend along the current aim.
  let baseX, baseY;
  if (isTracking) {
    const shipFwd = V.fromAngle(ship.heading);
    const pR = ship.spec.radius * CANNON_TURRET.pivotR;
    baseX = ship.pos.x + shipFwd.x * pR;
    baseY = ship.pos.y + shipFwd.y * pR;
  }

  for (let i = 0; i < muzzles; i++) {
    const lateral = muzzles === 1 ? 0 : ((i - (muzzles - 1) / 2) * muzzleSpread);
    let origin;
    if (isTracking) {
      const barrel = ship.spec.radius * CANNON_TURRET.barrelLen;
      origin = {
        x: baseX + aimDir.x * barrel + aimSide.x * lateral,
        y: baseY + aimDir.y * barrel + aimSide.y * lateral,
      };
    } else {
      // Bow-locked (fighters, etc.) — original behaviour.
      origin = {
        x: ship.pos.x + aimDir.x * (ship.spec.radius + 4) + aimSide.x * lateral,
        y: ship.pos.y + aimDir.y * (ship.spec.radius + 4) + aimSide.y * lateral,
      };
    }
    // Spread halved when the controller has tagged the prey as a small
    // moving target (fighter/bomber). At default fighter spread 0.05
    // rad, ±2.9° = ±25u scatter at 500u range — wider than a fighter's
    // hit radius. Halving brings the cone inside the target silhouette
    // for committed shots. The fighter AI sets c.aimingAtSmall only
    // when its target is actually a fighter/bomber and alignment is
    // tight, so this doesn't make all weapons laser-accurate — capital
    // cannons firing at strike craft keep their normal spread.
    const tightAim = ship.controller && ship.controller.aimingAtSmall;
    const spreadMul = tightAim ? 0.5 : 1.0;
    const spread = (Math.random() - 0.5) * 2 * w.spread * spreadMul;
    const dir = V.fromAngle(aimAngle + spread);
    const vel = {
      x: dir.x * w.projectileSpeed + ship.vel.x * 0.3,
      y: dir.y * w.projectileSpeed + ship.vel.y * 0.3,
    };
    world.projectiles.push(createProjectile({
      pos: origin,
      vel,
      damage: w.damage,
      ttl: w.range / w.projectileSpeed,
      radius: w.projectileRadius,
      color: w.projectileColors[ship.side],
      side: ship.side,
      ownerId: ship.id,
      kind: "cannon",
      fromKlass: ship.klass,
    }));
  }
  events.emit("weaponFired", {
    x: ship.pos.x, y: ship.pos.y,
    kind: ship.klass,
    // Per-module weapon voice: cruiser/carrier forward salvos read as a
    // a strike-cruiser naval gun; carrier (Thren) forward gun = deep
    // "heavy cannon"; fighter/bomber bow guns = a light autocannon.
    weapon: ship.klass === "cruiser" ? "cruisercannon"
      : ship.klass === "carrier" ? "heavycannon"
      : "autocannon",
    isPlayer: ship.isPlayer,
  });
}

// Slew the cruiser's cannon turret toward its commanded fire direction,
// capped at cannonTurnRate per second and clamped to the forward
// firing arc so the cannons can't aim behind the hull.
//
// Target direction priority:
//   1. `ship.cannonTargetDir` — the AI's lead-intercept vector. This
//      is set by cruiserAI every tick the cruiser has a target and
//      may differ wildly from c.aim (which steers the hull around
//      the target). Without this the turret would track the
//      perpendicular orbit slot instead of the target.
//   2. `c.aim` — fallback for any future cruiser-shaped class that
//      doesn't write cannonTargetDir.
function slewCannonAim(ship, dt) {
  // Legacy single-cannon path. Delegates to per-weapon helper using
  // ship.cannonAimAngle as the storage. Kept for any external caller.
  slewCannonAimForWeapon(ship, dt, {
    spec: ship.spec,
    cannonAimAngle: ship.cannonAimAngle,
    _setAim: (v) => { ship.cannonAimAngle = v; },
  });
}

// Per-weapon turret slew. Reads ship.cannonTargetDir / controller.aim
// like the legacy version but stores back into the weapon-state object.
function slewCannonAimForWeapon(ship, dt, w) {
  const c = ship.controller;
  const s = ship.spec;
  const aimVec = (ship.cannonTargetDir && (ship.cannonTargetDir.x !== 0 || ship.cannonTargetDir.y !== 0))
    ? ship.cannonTargetDir
    : c.aim;
  if (!aimVec || (aimVec.x === 0 && aimVec.y === 0)) return;
  const desired = Math.atan2(aimVec.y, aimVec.x);
  let delta = desired - w.cannonAimAngle;
  while (delta >  Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  const rate = s.cannonTurnRate || 0.7;
  const step = Math.sign(delta) * Math.min(Math.abs(delta), rate * dt);
  w.cannonAimAngle += step;
  let local = w.cannonAimAngle - ship.heading;
  while (local >  Math.PI) local -= Math.PI * 2;
  while (local < -Math.PI) local += Math.PI * 2;
  const arc = s.cannonArc || (Math.PI / 3);
  if      (local >  arc) local =  arc;
  else if (local < -arc) local = -arc;
  w.cannonAimAngle = ship.heading + local;
  // Legacy single-weapon helper path stores back via _setAim.
  if (typeof w._setAim === "function") w._setAim(w.cannonAimAngle);
}

// Per-weapon forward-fire update. Equivalent to the legacy single-weapon
// branch but reads + writes state from `w` (a ship.weapons[i] object).
function updateForwardFireForWeapon(ship, world, dt, w, c) {
  const wSpec = w.spec;
  // Magazine reload.
  if (wSpec.capacity != null && w.weaponReloading) {
    w.weaponReloadTimer -= dt;
    if (w.weaponReloadTimer <= 0) {
      w.weaponAmmo = wSpec.capacity;
      w.weaponReloading = false;
      w.weaponReloadTimer = 0;
    }
  }
  const hasAmmo = () => wSpec.capacity == null || w.weaponAmmo > 0;
  const consumeAmmo = () => {
    if (wSpec.capacity != null) {
      w.weaponAmmo -= 1;
      if (w.weaponAmmo <= 0) {
        w.weaponReloading = true;
        w.weaponReloadTimer = wSpec.reloadTime;
      }
    }
  };
  // Forward-cannon module gate — shared across all weapons for now.
  const gunModName = forwardGunModuleName(ship.klass);
  const gunMod = gunModName && ship.moduleByName ? ship.moduleByName[gunModName] : null;
  const gunLive = !gunMod || !gunMod.disabled;
  if (!gunLive) w.salvoShotsLeft = 0;

  // Salvo continuation.
  if (gunLive && w.salvoShotsLeft > 0) {
    w.salvoShotTimer -= dt;
    if (w.salvoShotTimer <= 0) {
      if (hasAmmo()) {
        fireForwardWeapon(ship, world, w);
        consumeAmmo();
        w.salvoShotsLeft -= 1;
        w.salvoShotTimer = wSpec.salvo.intraShotDelay;
        if (!hasAmmo()) w.salvoShotsLeft = 0;
      } else {
        w.salvoShotsLeft = 0;
      }
    }
  }

  // Start a new burst.
  const canStart = gunLive && c.firing && c.aim && w.cooldown <= 0 && hasAmmo() && w.salvoShotsLeft <= 0;
  if (canStart) {
    fireForwardWeapon(ship, world, w);
    consumeAmmo();
    w.cooldown = wSpec.cooldown;
    if (wSpec.salvo && hasAmmo()) {
      w.salvoShotsLeft = wSpec.salvo.shotsPerVolley - 1;
      w.salvoShotTimer = wSpec.salvo.intraShotDelay;
    }
  }
}

// ---------------------------------------------------------------------------
// Broadside fire (battleship barrage cannons).
// ---------------------------------------------------------------------------
// Legacy single-weapon broadside — synthesizes a weapon-state from
// ship.spec.weapon and delegates to the per-weapon version.
function updateBroadsideFire(ship, world, dt) {
  const synth = {
    spec: ship.spec.weapon,
    cooldownPort: ship.cooldownPort,
    cooldownStarboard: ship.cooldownStarboard,
    salvoPortShotsLeft: ship.salvoPortShotsLeft,
    salvoPortShotTimer: ship.salvoPortShotTimer,
    salvoStbdShotsLeft: ship.salvoStbdShotsLeft,
    salvoStbdShotTimer: ship.salvoStbdShotTimer,
  };
  updateBroadsideFireForWeapon(ship, world, dt, synth);
  // Sync back.
  ship.cooldownPort = synth.cooldownPort;
  ship.cooldownStarboard = synth.cooldownStarboard;
  ship.salvoPortShotsLeft = synth.salvoPortShotsLeft;
  ship.salvoPortShotTimer = synth.salvoPortShotTimer;
  ship.salvoStbdShotsLeft = synth.salvoStbdShotsLeft;
  ship.salvoStbdShotTimer = synth.salvoStbdShotTimer;
}

// Per-weapon broadside — same logic but reads + writes state from `w`
// (a ship.weapons[i] entry). Multiple broadside weapons share the same
// port/stbd module gate (BB only has one battery per side); each runs
// its own volley independently.
// Slew the broadside battery's per-side aim toward the nearest enemy inside
// its firing arc, clamped to ±broadsideArc of the beam (the side
// perpendicular); eases back to the beam when no target is present. Stored
// as world angles on the ship (broadsideAimPort/Stbd) and read by both
// emitBroadside (shell direction) and drawBroadsideArt (barrel rotation), so
// the guns visibly traverse to track. Called once per tick for broadside ships.
function slewBroadsideAim(ship, world, dt) {
  const s = ship.spec;
  const range2 = s.weapon && s.weapon.range ? s.weapon.range * s.weapon.range : Infinity;
  const half = s.broadsideArc != null ? s.broadsideArc : (25 * Math.PI) / 180;
  const rate = (s.broadsideTraverse || 1.4) * dt;
  const fwd = V.fromAngle(ship.heading);
  const sides = [
    ["broadsideAimPort", { x: -fwd.y, y: fwd.x }],
    ["broadsideAimStbd", { x: fwd.y, y: -fwd.x }],
  ];
  for (const [key, vec] of sides) {
    const beam = Math.atan2(vec.y, vec.x);
    if (ship[key] == null) ship[key] = beam;
    // Nearest live enemy within range AND within ±half of this beam.
    let bestD2 = Infinity, bestDelta = 0, found = false;
    for (const o of world.ships) {
      if (o.dead || o.surrendered || o.side === ship.side) continue;
      const dx = o.pos.x - ship.pos.x, dy = o.pos.y - ship.pos.y;
      const d2 = dx * dx + dy * dy;
      if (d2 > range2 || d2 < 1e-6) continue;
      let delta = Math.atan2(dy, dx) - beam;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      if (Math.abs(delta) > half) continue;
      if (d2 < bestD2) { bestD2 = d2; bestDelta = delta; found = true; }
    }
    const desired = beam + (found ? Math.max(-half, Math.min(half, bestDelta)) : 0);
    let d = desired - ship[key];
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    ship[key] += Math.sign(d) * Math.min(Math.abs(d), rate);
  }
}

function updateBroadsideFireForWeapon(ship, world, dt, w) {
  slewBroadsideAim(ship, world, dt);   // traverse the battery toward its target
  const s = ship.spec;
  const wSpec = w.spec;
  const fwd = V.fromAngle(ship.heading);
  const sidePort = { x: -fwd.y, y: fwd.x };
  const sideStarboard = { x: fwd.y, y: -fwd.x };

  const arcCos = Math.cos(s.broadsideArc || Math.PI / 4);
  const range = wSpec.range;
  const range2 = range * range;

  const hasTargetInArc = (sideVec) => {
    for (const other of world.ships) {
      if (other.dead || other.surrendered || other.side === ship.side) continue;
      const dx = other.pos.x - ship.pos.x;
      const dy = other.pos.y - ship.pos.y;
      const d2 = dx * dx + dy * dy;
      if (d2 > range2 || d2 < 1e-6) continue;
      const d = Math.sqrt(d2);
      const cosAng = (dx / d) * sideVec.x + (dy / d) * sideVec.y;
      if (cosAng >= arcCos) return true;
    }
    return false;
  };

  // Gather live cannon modules per fire side. The nautical-name/screen-vector
  // crosswise pairing still applies: sidePort fire (screen +y at heading 0)
  // is physically on the +offset.y flank, gated by broadside-stbd-N discs;
  // sideStarboard fire is on the −offset.y flank, gated by broadside-port-N.
  const livePortMods = [];
  const liveStbdMods = [];
  if (ship.moduleByName) {
    for (let i = 0; i < 3; i++) {
      const pm = ship.moduleByName["broadside-stbd-" + i];
      if (pm && !pm.disabled) livePortMods.push(pm);
      const sm = ship.moduleByName["broadside-port-" + i];
      if (sm && !sm.disabled) liveStbdMods.push(sm);
    }
  }
  const portLive = livePortMods.length > 0;
  const stbdLive = liveStbdMods.length > 0;

  if (wSpec.salvo) {
    if (w.salvoPortShotsLeft > 0) {
      w.salvoPortShotTimer -= dt;
      if (w.salvoPortShotTimer <= 0) {
        const fwdNow = V.fromAngle(ship.heading);
        const sidePortNow = { x: -fwdNow.y, y: fwdNow.x };
        // Abort the rest of the volley if the battery is gone OR no live
        // enemy remains on this flank. A broadside is a committed volley
        // (it keeps firing through the AI toggling fire off, so a moving
        // target gets traced) — but it must NOT keep raking empty space
        // after its target is destroyed or has cleared the arc.
        if (!portLive || !hasTargetInArc(sidePortNow)) {
          w.salvoPortShotsLeft = 0;
        } else {
          emitBroadside(ship, world, sidePortNow, fwdNow, wSpec, livePortMods, ship.broadsideAimPort);
          w.salvoPortShotsLeft -= 1;
          w.salvoPortShotTimer = wSpec.salvo.intraShotDelay;
        }
      }
    }
    if (w.salvoStbdShotsLeft > 0) {
      w.salvoStbdShotTimer -= dt;
      if (w.salvoStbdShotTimer <= 0) {
        const fwdNow = V.fromAngle(ship.heading);
        const sideStbdNow = { x: fwdNow.y, y: -fwdNow.x };
        if (!stbdLive || !hasTargetInArc(sideStbdNow)) {
          w.salvoStbdShotsLeft = 0;
        } else {
          emitBroadside(ship, world, sideStbdNow, fwdNow, wSpec, liveStbdMods, ship.broadsideAimStbd);
          w.salvoStbdShotsLeft -= 1;
          w.salvoStbdShotTimer = wSpec.salvo.intraShotDelay;
        }
      }
    }
  }

  if (portLive && w.cooldownPort <= 0 && w.salvoPortShotsLeft <= 0 && hasTargetInArc(sidePort)) {
    emitBroadside(ship, world, sidePort, fwd, wSpec, livePortMods, ship.broadsideAimPort);
    w.cooldownPort = wSpec.cooldown;
    if (wSpec.salvo) {
      w.salvoPortShotsLeft = wSpec.salvo.shotsPerVolley - 1;
      w.salvoPortShotTimer = wSpec.salvo.intraShotDelay;
    }
  }
  if (stbdLive && w.cooldownStarboard <= 0 && w.salvoStbdShotsLeft <= 0 && hasTargetInArc(sideStarboard)) {
    emitBroadside(ship, world, sideStarboard, fwd, wSpec, liveStbdMods, ship.broadsideAimStbd);
    w.cooldownStarboard = wSpec.cooldown;
    if (wSpec.salvo) {
      w.salvoStbdShotsLeft = wSpec.salvo.shotsPerVolley - 1;
      w.salvoStbdShotTimer = wSpec.salvo.intraShotDelay;
    }
  }
}

function emitBroadside(ship, world, sideVec, fwd, weaponSpec, liveModules, aimAngle) {
  const w = weaponSpec || ship.spec.weapon;
  // Shells fly along the battery's tracked aim (slewBroadsideAim) when given;
  // the muzzle ORIGINS still sit out on the beam (the guns are flank-mounted).
  const baseAngle = (aimAngle != null) ? aimAngle : Math.atan2(sideVec.y, sideVec.x);
  const R = ship.spec.radius;

  // Determine the set of muzzle origins. When individual cannon modules are
  // supplied, each live cannon fires one shell from its physical fore-aft
  // position along the hull edge. Fallback: legacy muzzle-spread computation.
  const origins = [];
  if (liveModules && liveModules.length > 0) {
    for (const mod of liveModules) {
      origins.push({
        x: ship.pos.x + sideVec.x * (R + 4) + fwd.x * mod.offset.x * R,
        y: ship.pos.y + sideVec.y * (R + 4) + fwd.y * mod.offset.x * R,
      });
    }
  } else {
    const muzzles = w.muzzles || 1;
    const muzzleSpread = w.muzzleSpread || 0;
    for (let i = 0; i < muzzles; i++) {
      const lengthwise = muzzles === 1 ? 0 : ((i - (muzzles - 1) / 2) * muzzleSpread);
      origins.push({
        x: ship.pos.x + sideVec.x * (R + 4) + fwd.x * lengthwise,
        y: ship.pos.y + sideVec.y * (R + 4) + fwd.y * lengthwise,
      });
    }
  }

  for (const origin of origins) {
    const spread = (Math.random() - 0.5) * 2 * w.spread;
    const dir = { x: Math.cos(baseAngle + spread), y: Math.sin(baseAngle + spread) };
    const vel = {
      x: dir.x * w.projectileSpeed + ship.vel.x * 0.3,
      y: dir.y * w.projectileSpeed + ship.vel.y * 0.3,
    };
    world.projectiles.push(createProjectile({
      pos: origin,
      vel,
      damage: w.damage,
      ttl: w.range / w.projectileSpeed,
      radius: w.projectileRadius,
      color: w.projectileColors[ship.side],
      side: ship.side,
      ownerId: ship.id,
      kind: "cannon",
      fromKlass: ship.klass,
    }));
  }
  events.emit("weaponFired", {
    x: ship.pos.x, y: ship.pos.y,
    kind: ship.klass, weapon: "broadside", isPlayer: ship.isPlayer,
  });
}

// ---------------------------------------------------------------------------
// Point-defence cannons.
// Each turret independently picks the highest-priority target:
//   1) missile in range
//   2) bomber in range  (their pods are the next wave of inbound missiles)
//   3) fighter in range
//   4) nearest enemy in range
// ---------------------------------------------------------------------------
function pdTurretOffset(ship, i) {
  // Read the turret's seated position straight off its module disc — the
  // SINGLE SOURCE OF TRUTH set in buildModules (edge-seated via
  // pdTurretLocalOffset). Guarantees the firing origin, the module disc,
  // and the visible turret art all coincide. Fall back to the legacy ring
  // if the module is missing (defensive).
  let lx, ly;
  // NB: pdTurretToModuleName is (klass, i, n) — passing a bare `i` would
  // land it in the klass slot and yield "pd-undefined", silently dropping
  // every turret back onto the legacy 0.75 ring. Pass the index in slot 2.
  const m = ship.moduleByName && ship.moduleByName[pdTurretToModuleName(ship.klass, i)];
  if (m) {
    lx = m.offset.x * ship.spec.radius;
    ly = m.offset.y * ship.spec.radius;
  } else {
    const n = ship.pdCooldowns.length;
    const ang = (i / n) * Math.PI * 2;
    const r = ship.spec.radius * 0.75;
    lx = Math.cos(ang) * r;
    ly = Math.sin(ang) * r;
  }
  // Rotate with the ship heading so turrets ride the hull.
  const ca = Math.cos(ship.heading), sa = Math.sin(ship.heading);
  return {
    x: ship.pos.x + lx * ca - ly * sa,
    y: ship.pos.y + lx * sa + ly * ca,
  };
}

function pickPDTarget(turretPos, range2, side, world) {
  let bestMissile = null, bestMissileD2 = range2;
  let bestBomber = null,  bestBomberD2 = range2;
  let bestFighter = null, bestFighterD2 = range2;
  let bestAny = null,     bestAnyD2 = range2;

  for (const p of world.projectiles) {
    if (p.dead || p.kind !== "missile" || p.side === side) continue;
    const dx = p.pos.x - turretPos.x;
    const dy = p.pos.y - turretPos.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestMissileD2) { bestMissileD2 = d2; bestMissile = p; }
  }
  if (bestMissile) return bestMissile;

  for (const o of world.ships) {
    if (o.dead || o.surrendered || o.side === side) continue;
    const dx = o.pos.x - turretPos.x;
    const dy = o.pos.y - turretPos.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > range2) continue;
    if (o.klass === "bomber" && d2 < bestBomberD2) {
      bestBomberD2 = d2; bestBomber = o;
    }
    if (o.klass === "fighter" && d2 < bestFighterD2) {
      bestFighterD2 = d2; bestFighter = o;
    }
    if (d2 < bestAnyD2) { bestAnyD2 = d2; bestAny = o; }
  }
  return bestBomber || bestFighter || bestAny;
}

// ---------------------------------------------------------------------------
// Ring cannons (frigate). Four fixed mounts arranged at the cardinal
// points of the hull (front / starboard / aft / port). Each fires
// independently when an enemy lies inside its arc + range. Lead-aim
// is computed per cannon; the projectile is tagged fromKlass:"frigate"
// so the PD-vs-ship nerf doesn't apply.
// ---------------------------------------------------------------------------
const RING_MOUNT_FACINGS = [0, Math.PI / 2, Math.PI, -Math.PI / 2]; // front, stbd, aft, port

function ringMountOrigin(ship, i) {
  // Place each mount on the hull rim along its facing direction.
  const localAng = RING_MOUNT_FACINGS[i];
  const lx = Math.cos(localAng) * ship.spec.radius;
  const ly = Math.sin(localAng) * ship.spec.radius;
  const ca = Math.cos(ship.heading), sa = Math.sin(ship.heading);
  return {
    x: ship.pos.x + lx * ca - ly * sa,
    y: ship.pos.y + lx * sa + ly * ca,
  };
}

function pickRingTarget(ship, mountWorldAng, arc, range2, world) {
  // Mount points outward at `mountWorldAng`; an enemy is in arc when
  // the bearing from mount-to-enemy is within ±arc of that direction.
  // Picks the nearest enemy that satisfies both checks; missiles and
  // fighters are valid targets like any other.
  const cosArc = Math.cos(arc);
  let best = null, bestD2 = range2;
  for (const o of world.ships) {
    if (o.dead || o.surrendered || o.side === ship.side) continue;
    const dx = o.pos.x - ship.pos.x;
    const dy = o.pos.y - ship.pos.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > range2 || d2 < 1e-6) continue;
    const d = Math.sqrt(d2);
    const cosTheta = (dx * Math.cos(mountWorldAng) + dy * Math.sin(mountWorldAng)) / d;
    if (cosTheta < cosArc) continue;
    if (d2 < bestD2) { bestD2 = d2; best = o; }
  }
  return best;
}

function updateRingFire(ship, world) {
  // Gun-array module gate: a frigate that's lost its cannon mount
  // can no longer fire ring shots. Cooldowns keep ticking so a repair
  // (if ever shipped) wouldn't need to re-seed timers.
  if (ship.moduleByName && ship.moduleByName["gun-array"] && ship.moduleByName["gun-array"].disabled) return;
  const rc = ship.spec.ringCannons;
  const range2 = rc.range * rc.range;
  for (let i = 0; i < ship.ringCooldowns.length; i++) {
    if (ship.ringCooldowns[i] > 0) continue;
    const mountWorldAng = ship.heading + RING_MOUNT_FACINGS[i];
    const tgt = pickRingTarget(ship, mountWorldAng, rc.arc, range2, world);
    if (!tgt) continue;
    const origin = ringMountOrigin(ship, i);
    // Lead-aim — same linear prediction as PD. If the target carries
    // modules (capitals), shift the aim point onto the next live
    // PD / weapon module so frigate ring cannons strip the screen
    // and weapon systems before chewing hull. Falls back to target
    // centre for fighters / bombers / unmoduled targets.
    const aimMod = pickAimModule(tgt);
    const aimPos = aimMod ? moduleOffsetWorld(tgt, aimMod) : tgt.pos;
    const tx = aimPos.x, ty = aimPos.y;
    const tvx = tgt.vel ? tgt.vel.x : 0;
    const tvy = tgt.vel ? tgt.vel.y : 0;
    const rx = tx - origin.x, ry = ty - origin.y;
    const tDist = Math.hypot(rx, ry);
    const tT = tDist / rc.projectileSpeed;
    const px = tx + tvx * tT, py = ty + tvy * tT;
    const ang = Math.atan2(py - origin.y, px - origin.x);
    const dir = V.fromAngle(ang);
    world.projectiles.push(createProjectile({
      pos: origin,
      vel: { x: dir.x * rc.projectileSpeed, y: dir.y * rc.projectileSpeed },
      damage: rc.damage,
      ttl: rc.range / rc.projectileSpeed,
      radius: rc.projectileRadius,
      color: rc.projectileColors[ship.side],
      side: ship.side,
      ownerId: ship.id,
      kind: "cannon",
      fromKlass: "frigate",
    }));
    ship.ringCooldowns[i] = rc.cooldown;
    events.emit("weaponFired", {
      x: origin.x, y: origin.y,
      kind: "frigate", weapon: "ringcannon", isPlayer: ship.isPlayer,
    });
  }
}

function updatePDFire(ship, world) {
  const pd = ship.spec.pdCannons;
  const range2 = pd.range * pd.range;
  // Per-turret aim angle (world-space radians). Allocated lazily so
  // old saves / mid-air ship spawns still work. The visual layer
  // (drawShip's PD turret pass) reads this each frame to slew the
  // barrels onto the turret's current target — even when the turret
  // is on cooldown, so the gun reads as actively tracking.
  if (!ship.pdAimAngles || ship.pdAimAngles.length !== ship.pdCooldowns.length) {
    ship.pdAimAngles = new Array(ship.pdCooldowns.length).fill(ship.heading);
  }
  // Track whether ANY turret loosed a round this tick. A PD ring fires
  // far too rapidly (N turrets × short cooldown) to sound per-shot, so we
  // emit a single throttled `pdFired` cue per ship per tick — main.js
  // probability-gates it further into a faint metallic rattle.
  let pdFiredThisTick = false;
  for (let i = 0; i < ship.pdCooldowns.length; i++) {
    // Skip turrets whose owning module has been knocked out.
    if (ship.pdTurretModules) {
      const modName = ship.pdTurretModules[i];
      const mod = modName && ship.moduleByName[modName];
      if (mod && mod.disabled) continue;
    }
    const origin = pdTurretOffset(ship, i);
    const tgt = pickPDTarget(origin, range2, ship.side, world);
    if (!tgt) continue;
    // Lead-aim: simple linear prediction.
    const tx = tgt.pos.x, ty = tgt.pos.y;
    const tvx = tgt.vel ? tgt.vel.x : 0;
    const tvy = tgt.vel ? tgt.vel.y : 0;
    const rx = tx - origin.x, ry = ty - origin.y;
    const tDist = Math.hypot(rx, ry);
    const tT = tDist / pd.projectileSpeed;
    const px = tx + tvx * tT, py = ty + tvy * tT;
    const ang = Math.atan2(py - origin.y, px - origin.x);
    ship.pdAimAngles[i] = ang;
    if (ship.pdCooldowns[i] > 0) continue;
    const dir = V.fromAngle(ang);
    world.projectiles.push(createProjectile({
      pos: origin,
      vel: { x: dir.x * pd.projectileSpeed, y: dir.y * pd.projectileSpeed },
      damage: pd.damage,
      ttl: pd.range / pd.projectileSpeed,
      radius: pd.projectileRadius,
      color: pd.projectileColors[ship.side],
      side: ship.side,
      ownerId: ship.id,
      ownerKlass: ship.klass,
      kind: "cannon",
      fromKlass: "pd",
    }));
    ship.pdCooldowns[i] = pd.cooldown;
    pdFiredThisTick = true;
  }
  if (pdFiredThisTick) {
    events.emit("pdFired", {
      x: ship.pos.x, y: ship.pos.y, isPlayer: ship.isPlayer,
    });
  }
}

// ---------------------------------------------------------------------------
// Missile pods (capitals + bombers): each pod cycles independently.
// Picks the largest enemy in range. Small craft (fighter / bomber) are
// excluded — capital pods are anti-capital weapons, the same way the
// heavy laser's target picker already filters them out. The PD ring +
// frigate ring cannons handle small-craft screening. Without this
// filter, bombers + frigates were dumping their entire pod cycle on
// the closest fighter wing and one-shotting whole escort packs (each
// pod fires the same tick on the same `pickPodTarget` result; the
// follow-on missiles then re-acquired to other fighters in the wing
// via projectile.js::acquireMissileTarget). End result: 5-6 escort
// fighters vanishing in under a second with only a small puff each.
// ---------------------------------------------------------------------------
function pickPodTarget(ship, world, acquireRange) {
  const RANK = { station: 5, battleship: 4, carrier: 3.5, cruiser: 3, frigate: 2 };
  const r2Max = acquireRange * acquireRange;
  let bestRank = -1, bestD2 = Infinity, best = null;
  for (const o of world.ships) {
    if (o.dead || o.surrendered || o.side === ship.side) continue;
    if (o.klass === "fighter" || o.klass === "bomber") continue;
    const dx = o.pos.x - ship.pos.x;
    const dy = o.pos.y - ship.pos.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > r2Max) continue;
    const rank = RANK[o.klass] || 0;
    if (rank > bestRank || (rank === bestRank && d2 < bestD2)) {
      bestRank = rank; bestD2 = d2; best = o;
    }
  }
  return best;
}

function updateMissilePodFire(ship, world) {
  // Admiral missile-hold: when the player has issued "hold missile
  // fire" for this ship's class, the pod cooldowns keep ticking (so
  // releasing the hold doesn't dump a stockpile) but no missiles
  // launch. Only the allied side honors directives — enemy fleets
  // run normal AI.
  if (world.directives && ship.side === "blue") {
    const dir = world.directives[ship.klass];
    if (dir && dir.missiles === "hold") return;
  }
  // Per-pod spec — each pod reads its own group spec from
  // ship.podSpecs[i]. Multi-slot capital designs produce mixed pod
  // specs (e.g. cluster + nuke); legacy single-spec hulls have every
  // entry pointing at the same group, which is functionally identical
  // to the old single-pods code path.
  // Pick one target per tick — pods on the same hull will spread out
  // naturally over time because each has its own cooldown phase.
  for (let i = 0; i < ship.podCooldowns.length; i++) {
    if (ship.podCooldowns[i] > 0) continue;
    // Skip pods whose missile bay is disabled.
    if (ship.podModules) {
      const modName = ship.podModules[i];
      const mod = modName && ship.moduleByName[modName];
      if (mod && mod.disabled) continue;
    }
    const pods = (ship.podSpecs && ship.podSpecs[i]) || ship.spec.missilePods;
    if (!pods) continue;
    const target = pickPodTarget(ship, world, pods.acquireRange);
    if (!target) continue;
    // Pod position: distributed along the hull length.
    const n = ship.podCooldowns.length;
    const offset = (n === 1) ? 0 : ((i - (n - 1) / 2) * (ship.spec.radius * 0.35));
    const fwd = V.fromAngle(ship.heading);
    const sideV = { x: -fwd.y, y: fwd.x };
    // Alternate pods to port / starboard.
    const sideSign = i % 2 === 0 ? 1 : -1;
    const origin = {
      x: ship.pos.x + fwd.x * offset + sideV.x * sideSign * ship.spec.radius * 0.55,
      y: ship.pos.y + fwd.y * offset + sideV.y * sideSign * ship.spec.radius * 0.55,
    };
    // Launch heading: outward, biased toward target.
    const toT = Math.atan2(target.pos.y - origin.y, target.pos.x - origin.x);
    const outward = ship.heading + sideSign * (Math.PI / 2);
    const launchHeading = lerpAngle(outward, toT, 0.4);

    const colors = pods.colors || { blue: "#fff", red: "#fc8" };
    // Bombers home onto a specific defensive module first (PD, then
    // broadsides, then anything else) so a strike wave actively peels
    // a capital's screen before chewing into hull.
    const targetModuleName = ship.klass === "bomber"
      ? pickBomberAimModule(target)
      : null;
    world.projectiles.push(createMissile({
      pos: origin,
      heading: launchHeading,
      damage: pods.damage,
      ttl: pods.ttl,
      radius: pods.radius,
      color: colors[ship.side],
      side: ship.side,
      ownerId: ship.id,
      speed: pods.projectileSpeed,
      turnRate: pods.turnRate,
      hp: pods.hp,
      fromKlass: ship.klass,
      acquireRange: pods.acquireRange,
      initialTarget: target,
      targetModuleName,
      cluster: pods.cluster || null,
      bypassShield: pods.bypassShield || false,
      blastRadius: pods.blastRadius || null,
    }));
    ship.podCooldowns[i] = pods.cooldown;
    events.emit("missileFired", {
      x: origin.x, y: origin.y,
      isPlayer: ship.isPlayer,
    });
  }
}

// ---------------------------------------------------------------------------
// Torpedo tubes (battleship). Slow, armor-piercing, massive hull damage.
// Two tubes on port/starboard flanks, each on its own cooldown.
// ---------------------------------------------------------------------------
function updateTorpedoFire(ship, world, dt) {
  const t = ship.spec.torpedoes;
  if (!ship.torpedoCooldowns) return;
  for (let i = 0; i < ship.torpedoCooldowns.length; i++) {
    ship.torpedoCooldowns[i] = Math.max(0, ship.torpedoCooldowns[i] - dt);
    if (ship.torpedoCooldowns[i] > 0) continue;
    // Gate on tube module liveness.
    if (ship.torpedoModules && ship.moduleByName) {
      const mod = ship.moduleByName[ship.torpedoModules[i]];
      if (mod && mod.disabled) continue;
    }
    const target = pickPodTarget(ship, world, t.acquireRange);
    if (!target) continue;
    const fwd = V.fromAngle(ship.heading);
    const sideSign = i % 2 === 0 ? -1 : 1; // port then starboard
    const sideV = { x: -fwd.y, y: fwd.x };
    const origin = {
      x: ship.pos.x + fwd.x * (ship.spec.radius * 0.28)
           + sideV.x * sideSign * ship.spec.radius * 0.44,
      y: ship.pos.y + fwd.y * (ship.spec.radius * 0.28)
           + sideV.y * sideSign * ship.spec.radius * 0.44,
    };
    const heading = Math.atan2(target.pos.y - origin.y, target.pos.x - origin.x);
    const colors = t.colors || { blue: "#4ff", red: "#f84" };
    world.projectiles.push(createMissile({
      pos: origin,
      heading,
      damage: t.damage,
      ttl: t.ttl,
      radius: t.radius,
      color: colors[ship.side],
      side: ship.side,
      ownerId: ship.id,
      speed: t.projectileSpeed,
      turnRate: t.turnRate,
      hp: t.hp,
      fromKlass: ship.klass,
      acquireRange: t.acquireRange,
      initialTarget: target,
      armorPiercing: t.armorPiercing || false,
      bypassShield: t.bypassShield || false,
      blastRadius: t.blastRadius || null,
    }));
    ship.torpedoCooldowns[i] = t.cooldown;
    events.emit("missileFired", { x: origin.x, y: origin.y, isPlayer: ship.isPlayer });
  }
}

function lerpAngle(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

// ---------------------------------------------------------------------------
// Fighter missile launcher (one-shot, manual or AI).
// ---------------------------------------------------------------------------
function fireFighterMissile(ship, world) {
  const m = ship.spec.missile;
  // Find a target: nearest enemy within acquireRange. AI doesn't bother
  // firing without one; player can fire anyway (acquireRange wide enough).
  let target = null;
  let bestD2 = m.acquireRange * m.acquireRange;
  for (const o of world.ships) {
    if (o.dead || o.surrendered || o.side === ship.side) continue;
    const dx = o.pos.x - ship.pos.x;
    const dy = o.pos.y - ship.pos.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) { bestD2 = d2; target = o; }
  }

  const fwd = V.fromAngle(ship.heading);
  const origin = {
    x: ship.pos.x + fwd.x * (ship.spec.radius + 6),
    y: ship.pos.y + fwd.y * (ship.spec.radius + 6),
  };
  world.projectiles.push(createMissile({
    pos: origin,
    heading: ship.heading,
    damage: m.damage,
    ttl: m.ttl,
    radius: m.radius,
    color: ship.side === "blue" ? "#cef" : "#fc8",
    side: ship.side,
    ownerId: ship.id,
    speed: m.projectileSpeed,
    turnRate: m.turnRate,
    hp: m.hp,
    fromKlass: ship.klass,
    acquireRange: m.acquireRange,
    initialTarget: target,
    antiCraftBonus: m.antiCraftBonus || null,
    bypassShield: m.bypassShield || false,
    blastRadius: m.blastRadius || null,
  }));
  events.emit("missileFired", {
    x: origin.x, y: origin.y,
    isPlayer: ship.isPlayer,
  });
}

// ---------------------------------------------------------------------------
// Heavy laser (battleship). Instant-hit beam in a forward arc.
// Spawns a beam record in world.beams; damage is applied in game.js.
// ---------------------------------------------------------------------------
function pickLaserTarget(ship, world) {
  // Array-aware: when the ship has multiple beam groups, pick by the
  // widest envelope (max range, max arc). Individual beams that don't
  // reach the target will simply not fire on this tick; their cooldown
  // keeps ticking until a closer target appears.
  const hl = ship.spec.heavyLaser;
  let range = 0, arc = 0;
  if (Array.isArray(hl)) {
    for (const g of hl) {
      if (!g) continue;
      if (g.range > range) range = g.range;
      if (g.arc > arc) arc = g.arc;
    }
  } else if (hl) {
    range = hl.range || 0;
    arc = hl.arc || 0;
  }
  const range2 = range * range;
  const arcCos = Math.cos(arc);
  const fwd = V.fromAngle(ship.heading);
  // Capital-only target table: aircraft (fighter / bomber) are too small
  // and too cheap for a heavy laser to bother — they fall off the list
  // entirely and the beam holds fire until a real ship of the line
  // crosses the arc. PD turrets handle aircraft.
  const RANK = { station: 5, battleship: 4, carrier: 3.5, cruiser: 3, frigate: 2 };
  let bestRank = -1, bestD2 = Infinity, best = null;
  for (const o of world.ships) {
    if (o.dead || o.surrendered || o.side === ship.side) continue;
    if (o.klass === "fighter" || o.klass === "bomber") continue;
    const dx = o.pos.x - ship.pos.x;
    const dy = o.pos.y - ship.pos.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > range2 || d2 < 1e-6) continue;
    const d = Math.sqrt(d2);
    const cosA = (dx / d) * fwd.x + (dy / d) * fwd.y;
    if (cosA < arcCos) continue;
    const rank = RANK[o.klass] || 0;
    if (rank > bestRank || (rank === bestRank && d2 < bestD2)) {
      bestRank = rank; bestD2 = d2; best = o;
    }
  }
  return best;
}

function updateHeavyLaser(ship, world) {
  // Per-laser destructible module routing. Single-beam BB uses one
  // "laser" module (legacy); multi-beam BB has "laser-fore" + "laser-aft"
  // — beam 0 routes to fore, beam 1+ routes to aft. Each beam's gate is
  // independent so killing one bay disables only that beam.
  const lasers = ship.laserSpecs || [ship.spec.heavyLaser];
  const cooldowns = ship.laserCooldowns || [ship.laserCd];
  const multiBeam = lasers.length >= 2;
  const moduleNameFor = (i) => {
    if (!multiBeam) return "laser";
    return i === 0 ? "laser-fore" : "laser-aft";
  };
  const liveMods = lasers.map((_, i) => {
    const mod = ship.moduleByName && ship.moduleByName[moduleNameFor(i)];
    return !mod || !mod.disabled;
  });
  const anyLiveMod = liveMods.some((v) => v);

  // Always track the best-priority target if any laser is live so the
  // barrel art reads as tracking even while cooldowns tick.
  const lookTarget = anyLiveMod ? pickLaserTarget(ship, world) : null;
  const aimAngle = lookTarget
    ? Math.atan2(lookTarget.pos.y - ship.pos.y, lookTarget.pos.x - ship.pos.x)
    : null;
  ship.laserAimAngle = aimAngle;
  if (ship.laserAimAngles) {
    for (let i = 0; i < ship.laserAimAngles.length; i++) {
      ship.laserAimAngles[i] = aimAngle;
    }
  }
  if (!anyLiveMod) return;
  // Per-laser fire loop. Each beam runs its own cooldown + its own
  // module gate (so a multi-beam BB losing fore-laser keeps aft-laser
  // firing).
  for (let i = 0; i < lasers.length; i++) {
    if (cooldowns[i] > 0) continue;
    if (!liveMods[i]) continue;
    const l = lasers[i];
    if (!l) continue;
    const target = pickLaserTarget(ship, world);
    if (!target) continue;

    const fwd = V.fromAngle(ship.heading);
    const origin = {
      x: ship.pos.x + fwd.x * ship.spec.radius * 0.9,
      y: ship.pos.y + fwd.y * ship.spec.radius * 0.9,
    };
    if (!world.beams) world.beams = [];
    world.beams.push({
      origin,
      target,
      range: l.range,
      damage: l.damage,
      dps: l.damage / l.beamDuration,
      duration: l.beamDuration,
      ttl: l.beamDuration,
      // Defensive: race-default lasers use `beamColors`; older custom
      // components might have used the wrong key. Fall back to a sane
      // default so a missing color doesn't crash the beam render.
      color: (l.beamColors && l.beamColors[ship.side])
          || (l.color && l.color[ship.side])
          || "#9ef",
      side: ship.side,
      ownerId: ship.id,
      hit: null,
    });
    events.emit("beamFired", {
      x: origin.x, y: origin.y,
      duration: l.beamDuration,
      isPlayer: ship.isPlayer,
    });
    cooldowns[i] = l.cooldown;
    // Keep ship.laserCd in sync with laserCooldowns[0] for any legacy
    // consumers that still read the scalar.
    if (i === 0) ship.laserCd = l.cooldown;
  }
}

// ---------------------------------------------------------------------------
// Rendering.
// ---------------------------------------------------------------------------

// Live engine glow / thrust plumes. Each plume corresponds to its own
// targetable engine module (engine-0, engine-1, ...). A plume's
// intensity scales with its module's HP — bright when healthy, dim and
// jittery near death, fully extinguished when that module is destroyed
// (the module-marker pass then paints the crater over the dead nozzle).
function drawEnginePlumes(ctx, ship) {
  const klass = ship.klass;
  const count = ENGINES[klass] || 0;
  if (count <= 0) return;
  const R = ship.spec.radius;
  const side = ship.side;

  const ex = (ENGINE_X[klass] || -0.9) * R;
  const glowHi = side === "blue" ? "rgba(140,210,255," : "rgba(255,180,100,";
  const glowMid = side === "blue" ? "rgba(80,170,255,"  : "rgba(255,130,60,";
  const glowR = R * (klass === "fighter" ? 0.18 : 0.14);
  for (let i = 0; i < count; i++) {
    // Per-plume gating: read this engine module's state.
    const eng = ship.moduleByName && ship.moduleByName["engine-" + i];
    if (eng && eng.disabled) continue;
    let intensity = 1;
    if (eng) {
      const frac = eng.hp / eng.hpMax;
      intensity = 0.35 + frac * 0.65;
      if (frac < 0.4) intensity *= 0.7 + Math.random() * 0.3;
    }
    const yOff = count === 1 ? 0 : ((i / (count - 1)) - 0.5) * R * 1.05;
    const g = ctx.createRadialGradient(ex, yOff, 0, ex, yOff, glowR * 2.4);
    g.addColorStop(0.0, glowHi + (0.95 * intensity).toFixed(3) + ")");
    g.addColorStop(0.45, glowMid + (0.50 * intensity).toFixed(3) + ")");
    g.addColorStop(1.0, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(ex, yOff, glowR * 2.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(240,250,255," + (0.95 * intensity).toFixed(3) + ")";
    ctx.beginPath();
    ctx.arc(ex + R * 0.02, yOff, glowR * 0.35, 0, Math.PI * 2);
    ctx.fill();
  }
}

// Paint one persistent battle scar inside the ship's rotated frame.
// "armor-flake" reads as a chipped/scratched plate (light irregular
// patch), "hull-hole" as a dark gouge with a hot rim. Both are drawn
// from a deterministic seed so the silhouette doesn't flicker frame to
// frame even though we re-generate the polygon path on every draw.
function drawScar(ctx, sc) {
  const r = sc.size;
  if (r <= 0.2) return;
  ctx.save();
  ctx.translate(sc.lx, sc.ly);
  ctx.rotate(sc.seed * Math.PI * 2);
  if (sc.kind === "armor-flake") {
    // Subtle scratched plate — muted gray with a dark seam, no rim
    // halo. Reads as a chip in the armor without drawing the eye
    // away from the actual hole / module craters.
    ctx.fillStyle = "rgba(140,148,160,0.45)";
    ctx.strokeStyle = "rgba(20,24,32,0.55)";
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    const n = 6;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const nr = r * (0.6 + 0.55 * Math.sin(sc.seed * 13.7 + i * 2.3));
      const x = Math.cos(a) * nr;
      const y = Math.sin(a) * nr;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  } else {
    // Hull hole — sooty crater in the same visual language as a
    // destroyed module node: dark irregular bore, dark sooty rim,
    // optional charred inner ring for bigger holes. No bright orange
    // ring (that read as a "floating rind" hovering above the hull).
    // Dark sooty outer ring — subtle, just enough to seat the crater
    // in the hull surface.
    ctx.strokeStyle = "rgba(20,16,18,0.75)";
    ctx.lineWidth = Math.max(0.6, r * 0.18);
    ctx.beginPath();
    ctx.arc(0, 0, r * 1.04, 0, Math.PI * 2);
    ctx.stroke();
    // Crater fill — irregular dark polygon.
    ctx.fillStyle = "rgba(0,0,0,0.92)";
    ctx.beginPath();
    const n = 7;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const nr = r * (0.65 + 0.45 * Math.sin(sc.seed * 17.1 + i * 3.1));
      const x = Math.cos(a) * nr;
      const y = Math.sin(a) * nr;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
    // Charred inner accent for larger craters — a slightly darker
    // off-centre disc that gives depth without painting a halo.
    if (r > 4) {
      ctx.fillStyle = "rgba(40,28,24,0.55)";
      ctx.beginPath();
      ctx.arc(r * 0.15, r * 0.1, r * 0.45, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}
// ---------------------------------------------------------------------------
// Module visual identity. Each kind draws a small distinctive sub-icon
// inside the module's hit disc so the player can read at a glance which
// systems are still online: a long forward barrel for laser, silo grid
// for missile launchers, perpendicular cannon row for broadsides, an
// animated turret for PD, a wide bay door for hangars, a single big
// tube for torpedoes. Engines stay minimal — the visible plume already
// identifies them.
//
// All draws happen in ship-local space; the caller has already done
// ctx.translate(ship.pos) + ctx.rotate(ship.heading). Inside this
// helper we further translate to (mx, my) so each icon can be written
// in module-local coordinates with the ship's +x forward axis.
function moduleKind(name) {
  if (name.startsWith("engine-")) return "engine";
  if (name.startsWith("pd-")) return "pd";
  if (name.startsWith("broadside-")) return "broadside";
  if (name.startsWith("shield-generator")) return "shield";
  if (name.startsWith("missile-")) return "missile";
  if (name.startsWith("laser")) return "laser";          // laser, laser-fore, laser-aft
  if (name === "hangar") return "hangar";
  if (name.startsWith("torpedo")) return "torpedo";      // torpedo-bay, torpedo-tube-port/stbd
  if (name === "cannon" || name === "gun" || name === "gun-array") return "gun";
  return "unknown";
}

// Per-faction energy signature used for shields and powered weapon modules.
// RGB triples; alpha added at draw time.
const FACTION_SHIELD = {
  terran:    [100, 200, 255],   // steel blue
  hegemony:  [255, 185,  60],   // imperial gold
  reavers:   [255,  85,  45],   // heat orange  (key is "reavers" — ship.race)
  voidsworn: [160,  75, 255],   // void violet
  thren:     [ 60, 220, 110],   // bioluminescent green
};

// Per-faction module body base color (RGB) — healthy plate tint.
const FACTION_MODULE = {
  terran:    [42,  75, 120],
  hegemony:  [90,  55,  20],
  reavers:   [80,  25,  18],    // key is "reavers" (was "reaver" → fell back to terran blue)
  voidsworn: [28,  18,  85],
  thren:     [18,  78,  32],
};

function factionShieldRGB(race) {
  return FACTION_SHIELD[race] || FACTION_SHIELD.terran;
}
function factionModuleRGB(race) {
  return FACTION_MODULE[race] || FACTION_MODULE.terran;
}

// Material palette — module body fill keyed by HP fraction and faction.
// Healthy modules show their faction base tint; damaged ones shift toward
// the universal orange/red damage read so the player always recognises
// critical systems regardless of faction.
function clamp255(v) { return v < 0 ? 0 : v > 255 ? 255 : v | 0; }

// Module plate base color as an [r,g,b] triple (healthy = faction tint,
// damaged = orange → red). drawModuleBase derives lit/shadow stops from it.
function moduleBodyRGB(frac, race) {
  if (frac > 0.66) {
    const [r, g, b] = factionModuleRGB(race);
    const bright = 0.55 + frac * 0.45;
    return [clamp255(r * bright + 60), clamp255(g * bright + 70), clamp255(b * bright + 80)];
  }
  if (frac > 0.33) return [200, 155, 90];
  return [230, 110, 75];
}
function moduleBodyColor(frac, race) {
  const [r, g, b] = moduleBodyRGB(frac, race);
  return `rgba(${r},${g},${b},0.9)`;
}
function moduleAccentColor(frac, race) {
  if (frac > 0.66) {
    const [r, g, b] = factionModuleRGB(race);
    return `rgba(${Math.round(r*1.15)},${Math.round(g*1.0)},${Math.round(b*1.0)},0.97)`;
  }
  if (frac > 0.33) return "rgba(105,72,32,0.97)";
  return "rgba(115,45,28,0.97)";
}

// ---------------------------------------------------------------------------
// Module hardware toolkit. Shared primitives that give every module the
// "raised armoured hardware + energy" read: a beveled base that sits proud
// of the hull (drop shadow → domed body → lit/shadowed rim → inset collar),
// rivets, per-faction flair, and energy glow with a slow idle pulse. The
// expensive passes (gradients, rivets, flair) are gated by `detail` so a
// far-zoomed 250-ship brawl stays as cheap as the old flat discs.
// ---------------------------------------------------------------------------

// Per-faction module styling: base-plate shape + trim accent + greeble kind.
const MODULE_STYLE = {
  terran:    { shape: "round",   trim: [170, 205, 240], rivets: 6, flair: "panel"  },
  hegemony:  { shape: "octagon", trim: [255, 210, 130], rivets: 8, flair: "ornate" },
  reavers:   { shape: "round",   trim: [235, 130,  95], rivets: 5, flair: "scrap"  },
  voidsworn: { shape: "round",   trim: [200, 150, 255], rivets: 0, flair: "rune"   },
  thren:     { shape: "organic", trim: [130, 240, 160], rivets: 0, flair: "bio"    },
};
function moduleStyle(race) { return MODULE_STYLE[race] || MODULE_STYLE.terran; }

// Slow idle glow 0..1; per-ship phase so a fleet doesn't pulse in lockstep.
function modPulse(ship, speed = 1.6, phase = 0) {
  const t = (typeof performance !== "undefined" ? performance.now() : Date.now()) / 1000;
  const ph = (((ship && ship.id) || 0) * 0.7) + phase;
  return 0.5 + 0.5 * Math.sin(t * speed + ph);
}

// Trace the base-plate outline of radius r in the faction's shape; the
// caller fills/strokes the current path.
function modShapePath(ctx, r, shape, seed = 0) {
  ctx.beginPath();
  if (shape === "octagon") {
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
      const x = Math.cos(a) * r, y = Math.sin(a) * r;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.closePath();
  } else if (shape === "organic") {
    const N = 16;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      const w = 1 + 0.13 * Math.sin(a * 3 + seed) + 0.07 * Math.sin(a * 5 + seed * 1.7);
      const x = Math.cos(a) * r * w, y = Math.sin(a) * r * w;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.closePath();
  } else {
    ctx.arc(0, 0, r, 0, Math.PI * 2);
  }
}

// Bolt/rivet studs ringing the plate rim (detail only).
function drawRivets(ctx, r, n, tr, tg, tb) {
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + 0.25;
    const x = Math.cos(a) * r, y = Math.sin(a) * r;
    ctx.fillStyle = "rgba(0,0,0,0.5)";
    ctx.beginPath(); ctx.arc(x + 0.4, y + 0.5, Math.max(0.8, r * 0.075), 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = `rgba(${tr},${tg},${tb},0.75)`;
    ctx.beginPath(); ctx.arc(x, y, Math.max(0.6, r * 0.06), 0, Math.PI * 2); ctx.fill();
  }
}

// The raised armoured base, drawn in module-local space (origin at centre).
// `seedKind` keeps the organic blob stable per module type. detail toggles
// the gradient dome + rivets.
function drawModuleBase(ctx, r, race, frac, detail, seedKind = 0) {
  const st = moduleStyle(race);
  const [br, bg, bb] = moduleBodyRGB(frac, race);
  const [tr, tg, tb] = st.trim;

  // Drop shadow — offset dark silhouette so the module reads as raised.
  ctx.save();
  ctx.translate(r * 0.10, r * 0.13);
  ctx.fillStyle = "rgba(0,0,0,0.40)";
  modShapePath(ctx, r, st.shape, seedKind);
  ctx.fill();
  ctx.restore();

  // Domed body.
  modShapePath(ctx, r, st.shape, seedKind);
  if (detail) {
    const g = ctx.createRadialGradient(-r * 0.35, -r * 0.42, r * 0.08, 0, 0, r * 1.15);
    g.addColorStop(0, `rgb(${clamp255(br + 60)},${clamp255(bg + 60)},${clamp255(bb + 65)})`);
    g.addColorStop(0.55, `rgb(${br},${bg},${bb})`);
    g.addColorStop(1, `rgb(${clamp255(br * 0.42)},${clamp255(bg * 0.42)},${clamp255(bb * 0.48)})`);
    ctx.fillStyle = g;
  } else {
    ctx.fillStyle = `rgb(${br},${bg},${bb})`;
  }
  ctx.fill();

  // Lit rim (top-left) + shadow rim (bottom-right) for a beveled edge.
  ctx.lineWidth = Math.max(1, r * 0.12);
  ctx.strokeStyle = `rgba(${tr},${tg},${tb},0.6)`;
  ctx.beginPath(); ctx.arc(0, 0, r * 0.9, Math.PI * 0.86, Math.PI * 1.9); ctx.stroke();
  ctx.strokeStyle = "rgba(0,0,0,0.45)";
  ctx.beginPath(); ctx.arc(0, 0, r * 0.9, Math.PI * 1.9, Math.PI * 2.86); ctx.stroke();

  // Inset mounting collar.
  ctx.lineWidth = Math.max(0.7, r * 0.06);
  ctx.strokeStyle = "rgba(0,0,0,0.38)";
  modShapePath(ctx, r * 0.64, st.shape, seedKind);
  ctx.stroke();

  if (detail && st.rivets > 0) drawRivets(ctx, r * 0.8, st.rivets, tr, tg, tb);
}

// Per-race greeble overlay drawn on the base before the weapon-specific
// hardware (detail only). Gives each faction a distinct signature.
function drawFactionFlair(ctx, race, r, pulse) {
  const st = moduleStyle(race);
  const [tr, tg, tb] = st.trim;
  if (st.flair === "ornate") {                       // Hegemony — gilt trim ring + crest
    ctx.strokeStyle = `rgba(${tr},${tg},${tb},0.55)`;
    ctx.lineWidth = Math.max(0.8, r * 0.05);
    ctx.beginPath(); ctx.arc(0, 0, r * 0.82, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = `rgba(${tr},${tg},${tb},0.5)`;
    for (let i = 0; i < 4; i++) { const a = i * Math.PI / 2 + Math.PI / 4;
      ctx.beginPath(); ctx.arc(Math.cos(a) * r * 0.82, Math.sin(a) * r * 0.82, r * 0.08, 0, Math.PI * 2); ctx.fill(); }
  } else if (st.flair === "scrap") {                 // Reaver — weld scar + spike
    ctx.strokeStyle = "rgba(18,11,9,0.6)";
    ctx.lineWidth = Math.max(0.8, r * 0.07);
    ctx.beginPath(); ctx.moveTo(-r * 0.55, -r * 0.18); ctx.lineTo(r * 0.32, r * 0.5); ctx.stroke();
    ctx.fillStyle = `rgba(${tr},${tg},${tb},0.5)`;
    ctx.beginPath(); ctx.moveTo(r * 0.68, -r * 0.32); ctx.lineTo(r * 1.05, -r * 0.52); ctx.lineTo(r * 0.74, -r * 0.04); ctx.closePath(); ctx.fill();
  } else if (st.flair === "rune") {                  // Voidsworn — glowing rune ticks
    ctx.strokeStyle = `rgba(${tr},${tg},${tb},${(0.4 + 0.45 * pulse).toFixed(2)})`;
    ctx.lineWidth = Math.max(0.8, r * 0.06);
    for (let i = 0; i < 4; i++) { const a = i * Math.PI / 2 + Math.PI / 4;
      ctx.beginPath(); ctx.moveTo(Math.cos(a) * r * 0.5, Math.sin(a) * r * 0.5);
      ctx.lineTo(Math.cos(a) * r * 0.84, Math.sin(a) * r * 0.84); ctx.stroke(); }
  } else if (st.flair === "bio") {                   // Thren — capillary veins
    ctx.strokeStyle = "rgba(18,60,30,0.55)";
    ctx.lineWidth = Math.max(0.6, r * 0.05);
    ctx.beginPath();
    ctx.moveTo(0, 0); ctx.quadraticCurveTo(r * 0.3, -r * 0.4, r * 0.62, -r * 0.22);
    ctx.moveTo(0, 0); ctx.quadraticCurveTo(-r * 0.3, r * 0.36, -r * 0.56, r * 0.16);
    ctx.stroke();
  } else {                                           // Terran — clean panel seam
    ctx.strokeStyle = "rgba(20,30,45,0.5)";
    ctx.lineWidth = Math.max(0.6, r * 0.04);
    ctx.beginPath(); ctx.moveTo(-r * 0.72, -r * 0.22); ctx.lineTo(r * 0.72, -r * 0.22); ctx.stroke();
  }
}

// Radiant faction-colored energy bloom (muzzle heat, charged lens, core).
function energyGlow(ctx, x, y, r, race, intensity) {
  if (intensity <= 0) return;
  const [er, eg, eb] = factionShieldRGB(race);
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, `rgba(255,255,255,${(0.9 * intensity).toFixed(3)})`);
  g.addColorStop(0.38, `rgba(${er},${eg},${eb},${(0.85 * intensity).toFixed(3)})`);
  g.addColorStop(1, `rgba(${er},${eg},${eb},0)`);
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
}

// A barrel with depth: dark underside, mid body, lit top stripe, optional
// banding. Drawn from x0 along +x, length L, half-width hw.
function drawBarrel(ctx, x0, L, hw, race, detail, bands = 0) {
  const [tr, tg, tb] = moduleStyle(race).trim;
  // Underside shadow.
  ctx.fillStyle = "rgba(0,0,0,0.5)";
  ctx.fillRect(x0, hw * 0.15, L, hw);
  // Body.
  ctx.fillStyle = "rgba(70,78,92,0.96)";
  ctx.fillRect(x0, -hw, L, hw * 1.15);
  // Lit top stripe.
  ctx.fillStyle = `rgba(${clamp255(tr * 0.5 + 120)},${clamp255(tg * 0.5 + 125)},${clamp255(tb * 0.5 + 135)},0.55)`;
  ctx.fillRect(x0, -hw, L, hw * 0.34);
  // Reinforcement bands.
  if (detail && bands > 0) {
    ctx.fillStyle = "rgba(14,16,22,0.7)";
    for (let i = 1; i <= bands; i++) {
      const bx = x0 + (L * i) / (bands + 1);
      ctx.fillRect(bx - hw * 0.12, -hw * 1.12, hw * 0.24, hw * 2.1);
    }
  }
}

function drawLaserArt(ctx, mr, frac, ship, detail) {
  // Heavy beam emitter: raised armoured base + a long cooling-finned
  // barrel that tracks the live aim, capped by a charged faction lens
  // that pulses while powered.
  const race = ship && ship.race;
  const pulse = modPulse(ship, 2.2);
  const [lr, lg, lb] = factionShieldRGB(race);
  drawModuleBase(ctx, mr * 0.98, race, frac, detail, 11);
  if (detail) drawFactionFlair(ctx, race, mr * 0.9, pulse);

  // Aim clamped to the beam arc (unchanged math).
  let localAim = 0;
  if (ship && ship.laserAimAngle != null) {
    const hl = ship.spec && ship.spec.heavyLaser;
    let arc = Math.PI / 2;
    if (Array.isArray(hl)) {
      arc = 0;
      for (const g of hl) if (g && g.arc > arc) arc = g.arc;
      if (arc === 0) arc = Math.PI / 2;
    } else if (hl && hl.arc) {
      arc = hl.arc;
    }
    let delta = ship.laserAimAngle - ship.heading;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    if (delta > arc) delta = arc;
    else if (delta < -arc) delta = -arc;
    localAim = delta;
  }

  ctx.save();
  ctx.rotate(localAim);

  // Emitter throat collar at the base of the barrel.
  ctx.fillStyle = "rgba(18,16,26,0.9)";
  ctx.beginPath(); ctx.arc(0, 0, mr * 0.42, 0, Math.PI * 2); ctx.fill();

  // Cooling-finned barrel with depth.
  const bl = mr * 1.78, hw = mr * 0.22;
  drawBarrel(ctx, mr * 0.18, bl - mr * 0.18, hw, race, detail, 0);
  if (detail) {
    // Heat-sink fins straddling the barrel.
    for (let f = 0; f < 3; f++) {
      const fx = mr * 0.18 + (bl - mr * 0.18) * (0.22 + f * 0.26);
      ctx.fillStyle = "rgba(30,34,44,0.95)";
      ctx.fillRect(fx, -hw * 1.7, mr * 0.1, hw * 3.4);
      ctx.fillStyle = `rgba(${lr},${lg},${lb},${(0.25 + 0.25 * pulse).toFixed(2)})`;
      ctx.fillRect(fx, -hw * 1.7, mr * 0.1, hw * 0.5);
    }
  }

  // Charged muzzle lens — dark housing + pulsing faction bloom + white core.
  const lx = bl;
  ctx.fillStyle = "rgba(10,9,16,0.96)";
  ctx.beginPath(); ctx.arc(lx, 0, mr * 0.3, 0, Math.PI * 2); ctx.fill();
  const hot = frac * (0.5 + 0.5 * pulse);
  if (detail) {
    energyGlow(ctx, lx, 0, mr * 0.6, race, hot);
  } else {
    ctx.fillStyle = `rgba(${lr},${lg},${lb},${(0.7 * frac).toFixed(2)})`;
    ctx.beginPath(); ctx.arc(lx, 0, mr * 0.22, 0, Math.PI * 2); ctx.fill();
  }
  ctx.fillStyle = `rgba(255,255,255,${(0.85 * frac).toFixed(2)})`;
  ctx.beginPath(); ctx.arc(lx, 0, mr * 0.12, 0, Math.PI * 2); ctx.fill();

  ctx.restore();
}

function drawMissileArt(ctx, mr, facing, frac, race, detail, pulse) {
  // Armoured VLS cluster: raised faction plate carrying a 2×2 ring of
  // tube hatches, each with a recessed bore and a warhead status light
  // that pulses amber when armed.
  ctx.save();
  ctx.rotate(facing);
  drawModuleBase(ctx, mr * 1.02, race, frac, detail, 5);
  if (detail) drawFactionFlair(ctx, race, mr * 0.92, pulse);
  const [tr, tg, tb] = moduleStyle(race).trim;

  // Centre spine rib between the silo columns.
  ctx.fillStyle = "rgba(0,0,0,0.4)";
  ctx.fillRect(-mr * 0.07, -mr * 0.78, mr * 0.14, mr * 1.56);

  const silo = mr * 0.3;
  const off  = mr * 0.4;
  const armed = frac > 0.5;
  for (const dx of [-off, off]) for (const dy of [-off, off]) {
    // Raised hatch rim (lit) + bore.
    ctx.fillStyle = `rgba(${tr},${tg},${tb},0.5)`;
    ctx.beginPath(); ctx.arc(dx, dy, silo, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "rgba(6,5,12,0.96)";
    ctx.beginPath(); ctx.arc(dx, dy, silo * 0.78, 0, Math.PI * 2); ctx.fill();
    // Warhead tip — pulsing status light.
    const lit = (armed ? 0.55 + 0.45 * pulse : 0.4) * (0.4 + frac * 0.6);
    if (detail) {
      energyGlow(ctx, dx, dy, silo * 0.95, race, lit * 0.6);
    }
    ctx.fillStyle = armed
      ? `rgba(255,205,110,${(0.55 + 0.4 * pulse * frac).toFixed(2)})`
      : `rgba(180,120,60,0.6)`;
    ctx.beginPath(); ctx.arc(dx, dy, silo * 0.34, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

function drawBroadsideArt(ctx, mr, ySign, frac, race, detail, pulse, localAim) {
  // Casemated broadside gun: raised armoured mount + a heavy turntable
  // breech and a banded barrel on a traversing mount, capped by a muzzle
  // brake that glows with residual heat. The barrel rotates to the battery's
  // tracked aim (localAim, ship-local); at rest that's ±90° (straight out
  // the beam).
  drawModuleBase(ctx, mr * 0.9, race, frac, detail, 7);
  if (detail) drawFactionFlair(ctx, race, mr * 0.82, pulse || 0);

  // Rotate the gun (breech + barrel) to its tracked aim; fall back to the
  // fixed beam-perpendicular when no aim has been computed yet.
  ctx.save();
  ctx.rotate(localAim != null ? localAim : (ySign > 0 ? Math.PI / 2 : -Math.PI / 2));

  // Turntable breech ring.
  ctx.fillStyle = "rgba(26,30,40,0.95)";
  ctx.beginPath(); ctx.arc(0, 0, mr * 0.5, 0, Math.PI * 2); ctx.fill();
  const [tr, tg, tb] = moduleStyle(race).trim;
  ctx.strokeStyle = `rgba(${tr},${tg},${tb},0.5)`;
  ctx.lineWidth = Math.max(0.8, mr * 0.07);
  ctx.beginPath(); ctx.arc(0, 0, mr * 0.5, 0, Math.PI * 2); ctx.stroke();

  // Banded barrel with depth.
  const bl = mr * 1.2, hw = mr * 0.2;
  drawBarrel(ctx, 0, bl, hw, race, detail, detail ? 2 : 0);

  // Muzzle brake — squared block + slits, with a faint heat ember.
  ctx.fillStyle = "rgba(14,12,16,0.95)";
  ctx.fillRect(bl - mr * 0.12, -hw * 1.25, mr * 0.22, hw * 2.5);
  ctx.fillStyle = "rgba(0,0,0,0.7)";
  for (let k = -1; k <= 1; k++) ctx.fillRect(bl - mr * 0.02, k * hw * 0.7 - hw * 0.12, mr * 0.12, hw * 0.24);
  if (detail && frac > 0.33) energyGlow(ctx, bl + mr * 0.05, 0, mr * 0.3, race, 0.25 * frac);

  ctx.restore();
}

function drawPdArt(ctx, mr, ship, frac, aimLocal, detail) {
  // Close-in weapon: raised armoured ring base + a powered turntable that
  // slews to its live aim, twin stub barrels with depth and hot muzzles,
  // and a faction-tinted sensor dome that pulses. aimLocal is the turret's
  // current bearing relative to the ship heading (set by the PD fire loop).
  const race = ship && ship.race;
  const [pr, pg, pb] = factionShieldRGB(race);
  const pulse = modPulse(ship, 3.0, (ship && ship.id || 0) * 0.9);

  // Armoured base (faction shape) — slightly smaller so barrels overhang.
  drawModuleBase(ctx, mr * 0.92, race, frac, detail, 3);

  // Tracking gun platform.
  ctx.save();
  ctx.rotate(aimLocal || 0);

  // Turntable disc with a lit leading edge.
  ctx.fillStyle = "rgba(30,36,48,0.96)";
  ctx.beginPath(); ctx.arc(0, 0, mr * 0.52, 0, Math.PI * 2); ctx.fill();
  if (detail) {
    ctx.strokeStyle = `rgba(${pr},${pg},${pb},0.5)`;
    ctx.lineWidth = Math.max(0.8, mr * 0.08);
    ctx.beginPath(); ctx.arc(0, 0, mr * 0.52, -0.9, 0.9); ctx.stroke();
  }

  // Twin stub barrels with depth + hot muzzles.
  const hw = mr * 0.11, bl = mr * 1.05, spread = mr * 0.28;
  for (const sign of [-1, 1]) {
    ctx.save();
    ctx.translate(0, sign * spread);
    drawBarrel(ctx, mr * 0.18, bl - mr * 0.18, hw, race, detail, 0);
    if (frac > 0.1) {
      const hot = (0.45 + 0.45 * pulse) * frac;
      if (detail) energyGlow(ctx, bl, 0, mr * 0.28, race, hot);
      ctx.fillStyle = `rgba(${pr},${pg},${pb},${(0.6 * frac).toFixed(2)})`;
      ctx.beginPath(); ctx.arc(bl, 0, hw * 0.95, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  // Sensor dome — domed cap + pulsing faction eye.
  ctx.fillStyle = "rgba(22,26,36,0.95)";
  ctx.beginPath(); ctx.arc(0, 0, mr * 0.34, 0, Math.PI * 2); ctx.fill();
  if (frac > 0.33) {
    ctx.fillStyle = `rgba(${pr},${pg},${pb},${(0.45 + 0.4 * pulse).toFixed(2)})`;
    ctx.beginPath(); ctx.arc(0, 0, mr * 0.17, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = `rgba(255,255,255,${(0.5 * frac).toFixed(2)})`;
    ctx.beginPath(); ctx.arc(-mr * 0.05, -mr * 0.05, mr * 0.06, 0, Math.PI * 2); ctx.fill();
  }

  ctx.restore();
}

function drawHangarArt(ctx, mr, frac, race, detail, pulse) {
  // Recessed launch bay: raised deck housing + a dark interior throat with
  // hazard chevrons along the lip and a faction-tinted launch glow that
  // breathes from inside.
  drawModuleBase(ctx, mr * 1.04, race, frac, detail, 9);
  const w = mr * 1.7, h = mr * 1.2;
  // Bay throat — recessed, with a soft interior glow.
  ctx.fillStyle = "rgba(0,0,0,0.9)";
  ctx.fillRect(-w / 2, -h / 2, w, h);
  if (detail) {
    const g = ctx.createLinearGradient(-w / 2, 0, w / 2, 0);
    const [er, eg, eb] = factionShieldRGB(race);
    const a = (0.18 + 0.18 * (pulse || 0)) * (0.4 + frac * 0.6);
    g.addColorStop(0, `rgba(${er},${eg},${eb},0)`);
    g.addColorStop(1, `rgba(${er},${eg},${eb},${a.toFixed(2)})`);
    ctx.fillStyle = g;
    ctx.fillRect(-w / 2, -h / 2, w, h);
  }
  // Hazard chevrons along the forward lip.
  ctx.save();
  ctx.beginPath(); ctx.rect(w / 2 - mr * 0.26, -h / 2, mr * 0.26, h); ctx.clip();
  for (let i = -3; i < 4; i++) {
    ctx.fillStyle = i % 2 === 0 ? "rgba(240,200,50,0.95)" : "rgba(25,22,12,0.95)";
    ctx.save(); ctx.translate(w / 2 - mr * 0.13, i * mr * 0.3); ctx.rotate(-0.5);
    ctx.fillRect(-mr * 0.3, -mr * 0.14, mr * 0.6, mr * 0.16); ctx.restore();
  }
  ctx.restore();
  // Launch guide chevron.
  ctx.fillStyle = "rgba(210,225,255,0.8)";
  ctx.beginPath();
  ctx.moveTo(mr * 0.5, 0); ctx.lineTo(-mr * 0.15, -mr * 0.34); ctx.lineTo(-mr * 0.15, mr * 0.34);
  ctx.closePath(); ctx.fill();
}

function drawTorpedoArt(ctx, mr, frac, race, detail, pulse) {
  // Heavy launch tube seen end-on: raised faction mount + a deep bore with
  // blast-shield fins and a primed warhead glowing in the throat.
  drawModuleBase(ctx, mr * 0.98, race, frac, detail, 13);
  if (detail) drawFactionFlair(ctx, race, mr * 0.88, pulse || 0);
  // Blast-shield fins (X brace).
  ctx.strokeStyle = "rgba(8,8,12,0.8)";
  ctx.lineWidth = Math.max(1, mr * 0.16);
  ctx.beginPath();
  ctx.moveTo(-mr * 0.8, 0); ctx.lineTo(mr * 0.8, 0);
  ctx.moveTo(0, -mr * 0.8); ctx.lineTo(0, mr * 0.8);
  ctx.stroke();
  // Deep tube bore.
  ctx.fillStyle = "rgba(10,8,14,0.97)";
  ctx.beginPath(); ctx.arc(0, 0, mr * 0.52, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.6)";
  ctx.lineWidth = Math.max(0.8, mr * 0.06);
  ctx.beginPath(); ctx.arc(0, 0, mr * 0.52, 0, Math.PI * 2); ctx.stroke();
  // Primed warhead glow in the throat.
  const hot = (0.45 + 0.45 * (pulse || 0)) * (0.3 + frac * 0.7);
  if (detail) energyGlow(ctx, 0, 0, mr * 0.5, race, hot);
  ctx.fillStyle = `rgba(255,255,255,${(0.7 * frac).toFixed(2)})`;
  ctx.beginPath(); ctx.arc(0, 0, mr * 0.16, 0, Math.PI * 2); ctx.fill();
}

function drawGunArt(ctx, mr, frac, race, detail) {
  // Precision cannon: raised faction mount + a banded forward barrel with
  // depth, a muzzle brake, and warm muzzle heat.
  drawModuleBase(ctx, mr * 0.94, race, frac, detail, 1);
  if (detail) drawFactionFlair(ctx, race, mr * 0.84, 0);

  const bl = mr * 1.3, hw = mr * 0.22;
  drawBarrel(ctx, mr * 0.1, bl - mr * 0.1, hw, race, detail, detail ? 2 : 0);
  // Muzzle brake.
  ctx.fillStyle = "rgba(10,8,14,0.92)";
  ctx.fillRect(bl - mr * 0.14, -hw * 1.2, mr * 0.2, hw * 2.4);
  ctx.fillStyle = "rgba(0,0,0,0.7)";
  ctx.fillRect(bl - mr * 0.04, -hw * 0.5, mr * 0.12, hw);
  // Muzzle heat.
  if (frac > 0.1) {
    if (detail) energyGlow(ctx, bl + mr * 0.04, 0, mr * 0.34, race, 0.4 * frac);
    ctx.fillStyle = "rgba(255,215,150,0.9)";
    ctx.beginPath(); ctx.arc(bl + mr * 0.02, 0, hw * 0.55, 0, Math.PI * 2); ctx.fill();
  }
}

function drawEngineArt(ctx, mr, frac, race, detail) {
  // Engine nozzle bell: armoured housing + concentric thrust rings funneling
  // into a glowing throat. The exhaust plume is drawn separately; this is
  // the powered nozzle mouth sitting on the hull. (Engine glow tracks HP,
  // not the idle pulse the other modules use.)
  drawModuleBase(ctx, mr * 0.98, race, frac, detail, 17);
  // Concentric nozzle rings (funnel illusion).
  const rings = detail ? 3 : 1;
  for (let i = 0; i < rings; i++) {
    const rr = mr * (0.72 - i * 0.18);
    ctx.strokeStyle = i % 2 === 0 ? "rgba(10,10,16,0.85)" : "rgba(60,66,80,0.7)";
    ctx.lineWidth = Math.max(1, mr * 0.1);
    ctx.beginPath(); ctx.arc(0, 0, rr, 0, Math.PI * 2); ctx.stroke();
  }
  // Glowing throat — hot blue/orange by side-agnostic faction heat, scaled
  // by engine HP so a dying engine's throat goes cold.
  const throat = mr * 0.34;
  ctx.fillStyle = "rgba(12,10,16,0.95)";
  ctx.beginPath(); ctx.arc(0, 0, throat, 0, Math.PI * 2); ctx.fill();
  const heat = frac * 0.9;
  if (detail) energyGlow(ctx, 0, 0, throat * 1.4, race, heat);
  ctx.fillStyle = `rgba(255,240,210,${(0.85 * frac).toFixed(2)})`;
  ctx.beginPath(); ctx.arc(0, 0, throat * 0.45, 0, Math.PI * 2); ctx.fill();
}

function drawShieldArt(ctx, mr, frac, race, detail, pulse) {
  // Shield projector: armoured generator housing + a domed emitter coil
  // that pulses with the faction energy color (these were plain discs).
  drawModuleBase(ctx, mr * 0.96, race, frac, detail, 23);
  const [er, eg, eb] = factionShieldRGB(race);
  // Emitter coils — two arcs hugging the dome.
  if (detail) {
    ctx.strokeStyle = `rgba(${er},${eg},${eb},${(0.4 + 0.35 * (pulse || 0)).toFixed(2)})`;
    ctx.lineWidth = Math.max(0.8, mr * 0.09);
    ctx.beginPath(); ctx.arc(0, 0, mr * 0.6, -2.2, -0.5); ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, mr * 0.6, 0.9, 2.6); ctx.stroke();
  }
  // Emitter dome — dark cap + pulsing energy core.
  ctx.fillStyle = "rgba(20,24,34,0.95)";
  ctx.beginPath(); ctx.arc(0, 0, mr * 0.46, 0, Math.PI * 2); ctx.fill();
  const lit = (0.4 + 0.5 * (pulse || 0)) * (0.35 + frac * 0.65);
  if (detail) energyGlow(ctx, 0, 0, mr * 0.6, race, lit);
  ctx.fillStyle = `rgba(${er},${eg},${eb},${(0.6 * frac).toFixed(2)})`;
  ctx.beginPath(); ctx.arc(0, 0, mr * 0.22, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = `rgba(255,255,255,${(0.6 * frac).toFixed(2)})`;
  ctx.beginPath(); ctx.arc(0, 0, mr * 0.1, 0, Math.PI * 2); ctx.fill();
}

function drawModuleArt(ctx, m, mx, my, mr, frac, ship, detail) {
  const race = ship && ship.race;
  const pulse = modPulse(ship);
  ctx.save();
  ctx.translate(mx, my);
  switch (moduleKind(m.name)) {
    case "laser":     drawLaserArt(ctx, mr, frac, ship, detail); break;
    case "missile":   drawMissileArt(ctx, mr, m.name === "missile-aft" ? Math.PI : 0, frac, race, detail, pulse); break;
    case "broadside": {
      // +y-flank guns fire on the port beam, -y-flank on starboard (the
      // nautical-name crosswise pairing). Rotate the barrel to that side's
      // tracked aim, expressed in the ship-local frame.
      const yS = m.offset.y >= 0 ? 1 : -1;
      const aimW = yS > 0 ? ship.broadsideAimPort : ship.broadsideAimStbd;
      const localAim = (aimW != null) ? (aimW - ship.heading) : null;
      drawBroadsideArt(ctx, mr, yS, frac, race, detail, pulse, localAim);
      break;
    }
    case "hangar":    drawHangarArt(ctx, mr, frac, race, detail, pulse); break;
    case "torpedo":   drawTorpedoArt(ctx, mr, frac, race, detail, pulse); break;
    case "engine":    drawEngineArt(ctx, mr, frac, race, detail); break;
    case "shield":    drawShieldArt(ctx, mr, frac, race, detail, pulse); break;
    case "gun":       drawGunArt(ctx, mr, frac, race, detail); break;
    default:
      // Generic subsystem — still gets the raised armoured plate.
      drawModuleBase(ctx, mr * 0.95, race, frac, detail, 29);
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
export function drawShip(ctx, ship, zoom = 1) {
  const s = ship.spec;
  const tint = SIDES[ship.side].primary;
  // Screen-pixel radius of this ship after the camera transform. Used to
  // gate cheap detail like module damage-stage chrome and wounded-cell
  // halos — far-zoomed-out ships in a 250-ship brawl drop those passes
  // to save fill-time on details the eye can't resolve at this scale.
  const screenRadius = s.radius * zoom;
  const detail = screenRadius >= 12;
  ctx.save();
  ctx.translate(ship.pos.x, ship.pos.y);
  ctx.rotate(ship.heading);

  // Surrendered ships dim to ~55% so they read clearly as
  // non-combatants. A white-flag mark gets drawn AFTER the hull pass
  // at full opacity.
  if (ship.surrendered) {
    ctx.globalAlpha *= 0.55;
  }

  ctx.strokeStyle = tint;
  ctx.fillStyle = SIDES[ship.side].accent;
  ctx.lineWidth = 2;

  // Hull — block grid canvas (the ship is rendered as a grid of destructible
  // blocks). The offscreen canvas is rebuilt only when cells change (dirty
  // flag). Falls back to the pre-rendered sprite if no cell grid exists
  // (e.g. station nodes, or a class not in CELL_GRID).
  if (ship.cells) {
    if (ship.blockDirty) rebuildBlockCanvas(ship);
    if (ship.blockCanvas && ship.blockCanvas.width > 0) {
      ctx.drawImage(ship.blockCanvas, -ship.cellHalfX - 1, -ship.cellHalfY - 1);
    }
  } else {
    const sprite = getSprite(ship.race, ship.klass, ship.side);
    if (sprite) {
      const scale = s.radius / sprite.baseRadius;
      const half = sprite.halfExtent * scale;
      ctx.drawImage(sprite.canvas, -half, -half, half * 2, half * 2);
    } else {
      const poly = getHull(ship.race, ship.klass);
      ctx.beginPath();
      ctx.moveTo(poly[0][0] * s.radius, poly[0][1] * s.radius);
      for (let i = 1; i < poly.length; i++) {
        ctx.lineTo(poly[i][0] * s.radius, poly[i][1] * s.radius);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
  }

  // Player cosmetic paint: for block-hull ships the primary paint tints
  // the block canvas; for sprite-hull ships it overlays the polygon.
  // Block ships: skip (color is baked into the block palette per faction).
  if (!ship.cells && ship.paint && (ship.paint.primary || ship.paint.trim)) {
    const poly = getHull(ship.race, ship.klass);
    if (poly) {
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(poly[0][0] * s.radius, poly[0][1] * s.radius);
      for (let i = 1; i < poly.length; i++) {
        ctx.lineTo(poly[i][0] * s.radius, poly[i][1] * s.radius);
      }
      ctx.closePath();
      if (ship.paint.primary) {
        ctx.fillStyle = ship.paint.primary;
        ctx.globalAlpha = 0.32;
        ctx.fill();
      }
      if (ship.paint.trim) {
        ctx.strokeStyle = ship.paint.trim;
        ctx.lineWidth = 2.5;
        ctx.globalAlpha = 0.95;
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  // Engine plumes — drawn live so they can dim with engine module HP and
  // black out entirely when the engine module is destroyed. Reads
  // ship.moduleByName.engine if present (added for every mobile class).
  // Stations have no engine entry; their ENGINES[klass] is 0 so this
  // is a no-op for them.
  drawEnginePlumes(ctx, ship);

  // Persistent battle damage — armor flakes and hull holes accumulated
  // from incoming fire. Drawn inside the rotated frame so they ride with
  // the hull. Holes grow under sustained nearby fire (game.js merges
  // nearby impacts into the same scar instead of stacking new ones).
  if (ship.scars && ship.scars.length > 0) {
    for (const sc of ship.scars) drawScar(ctx, sc);
  }

  // Block smolder — hit cells slowly cool from a dim dark-red ember
  // glow, fading over several seconds like hot metal after impact.
  if (ship.cells) {
    const cw = ship.cellW;
    const ch = ship.cellH;
    let anyFlash = false;
    for (const cell of ship.cells) {
      if (!cell.dead && cell.flash > 0.02) { anyFlash = true; break; }
    }
    if (anyFlash) {
      for (const cell of ship.cells) {
        if (cell.dead || cell.flash <= 0.02) continue;
        // Dim dark-red ember: bright at first hit, cools to nothing.
        const t = cell.flash;
        const r = Math.round(55 + t * 45);
        const g = Math.round(t * 18);
        const b = Math.round(t * 8);
        ctx.fillStyle = `rgba(${r},${g},${b},`;
        ctx.globalAlpha = Math.min(0.72, t * 0.72);
        ctx.fillRect(cell.lx - cw / 2, cell.ly - ch / 2, cw, ch);
        cell.flash -= 0.014;  // fades over ~4 seconds at 60 fps
      }
      ctx.globalAlpha = 1;
    }
  }

  // Forward cannon rendering. Carrier (Thren) gets a dedicated spinal
  // bio-weapon; all other forward-firing classes use the cruiser turret.
  if (ship.spec.firingMode === "forward" && ship.cannonAimAngle != null) {
    const w = ship.spec.weapon;
    const pivotR   = s.radius * CANNON_TURRET.pivotR;
    const barrelLen = s.radius * CANNON_TURRET.barrelLen;
    const baseR    = Math.max(3, s.radius * 0.10);
    const barrelW  = Math.max(2.5, s.radius * 0.07);
    const aimLocal = ship.cannonAimAngle - ship.heading;
    const cannonDead = ship.moduleByName && ship.moduleByName.cannon && ship.moduleByName.cannon.disabled;

    if (ship.klass === "carrier") {
      // Thren spinal bio-cannon: a single massive organic barrel with
      // segmented ribbing, bioluminescent charge nodes, and a muzzle bloom.
      const bW   = barrelW * 1.9;
      const pivX = pivotR;
      ctx.save();
      ctx.translate(pivX, 0);
      ctx.rotate(aimLocal);

      // Mounting base — thick organic ring anchoring the barrel to the bow
      ctx.fillStyle = cannonDead ? "rgba(25,45,30,0.8)" : "rgba(30,65,42,0.95)";
      ctx.beginPath();
      ctx.ellipse(0, 0, baseR * 2.0, baseR * 1.6, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = cannonDead ? "rgba(20,45,28,0.4)" : "rgba(70,190,120,0.45)";
      ctx.lineWidth = Math.max(1.5, s.radius * 0.012);
      ctx.stroke();

      // Main barrel tube
      ctx.fillStyle = cannonDead ? "rgba(18,38,24,0.65)" : "rgba(22,52,32,1.0)";
      ctx.fillRect(0, -bW / 2, barrelLen, bW);

      // Organic ribbing — segmented rings along the barrel
      const ridgeCount = 5;
      for (let r = 0; r < ridgeCount; r++) {
        const rx = barrelLen * (0.12 + r * 0.16);
        const rw = Math.max(2, barrelLen * 0.05);
        ctx.fillStyle = cannonDead ? "rgba(18,38,24,0.45)" : "rgba(32,72,46,0.95)";
        ctx.fillRect(rx, -bW * 0.62, rw, bW * 1.24);
        // Bioluminescent charge nodes on each rib
        if (!cannonDead) {
          const nodeSz = bW * 0.16;
          ctx.fillStyle = "rgba(90,220,150,0.65)";
          ctx.beginPath();
          ctx.arc(rx + rw * 0.5, -bW * 0.38, nodeSz, 0, Math.PI * 2);
          ctx.fill();
          ctx.beginPath();
          ctx.arc(rx + rw * 0.5,  bW * 0.38, nodeSz, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // Specular top edge — faint highlight along the barrel spine
      ctx.beginPath();
      ctx.moveTo(barrelLen * 0.08, -bW * 0.38);
      ctx.lineTo(barrelLen * 0.92, -bW * 0.38);
      ctx.lineWidth = bW * 0.14;
      ctx.strokeStyle = cannonDead ? "rgba(30,55,38,0.3)" : "rgba(110,200,150,0.28)";
      ctx.stroke();

      // Muzzle bloom — bioluminescent charge at the tip
      if (!cannonDead) {
        const mg = ctx.createRadialGradient(barrelLen, 0, 0, barrelLen, 0, bW * 1.8);
        mg.addColorStop(0,   "rgba(200,255,220,0.95)");
        mg.addColorStop(0.35,"rgba(80,210,140,0.55)");
        mg.addColorStop(1.0, "rgba(40,160,100,0)");
        ctx.fillStyle = mg;
        ctx.beginPath();
        ctx.arc(barrelLen, 0, bW * 1.8, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.restore();

    } else {
      // Standard cruiser bow turret — armoured base disc + parallel barrels
      // with faction color ring and muzzle tip glow.
      const muzzles      = w.muzzles || 1;
      const muzzleSpread = w.muzzleSpread || 0;
      const aimSideX     = -Math.sin(aimLocal);
      const aimSideY     =  Math.cos(aimLocal);
      const [cr, cg, cb] = factionShieldRGB(ship.race);

      // Base disc — dark plate with faction ring when alive.
      ctx.fillStyle = cannonDead ? "rgba(50,25,25,0.80)" : "rgba(38,52,72,0.95)";
      ctx.beginPath();
      ctx.arc(pivotR, 0, baseR, 0, Math.PI * 2);
      ctx.fill();
      if (!cannonDead) {
        ctx.strokeStyle = `rgba(${cr},${cg},${cb},0.50)`;
        ctx.lineWidth = Math.max(1, baseR * 0.25);
        ctx.beginPath(); ctx.arc(pivotR, 0, baseR * 0.78, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.strokeStyle = "rgba(20,35,55,0.90)";
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(pivotR, 0, baseR, 0, Math.PI * 2); ctx.stroke();

      for (let i = 0; i < muzzles; i++) {
        const lateral = muzzles === 1 ? 0 : ((i - (muzzles - 1) / 2) * muzzleSpread);
        const bx = pivotR + aimSideX * lateral;
        const by = aimSideY * lateral;
        ctx.save();
        ctx.translate(bx, by);
        ctx.rotate(aimLocal);
        // Barrel — dark steel with slight highlight edge.
        ctx.fillStyle = cannonDead ? "rgba(55,25,25,0.65)" : "rgba(170,185,205,0.95)";
        ctx.fillRect(0, -barrelW / 2, barrelLen, barrelW);
        if (!cannonDead) {
          // Top edge highlight.
          ctx.fillStyle = "rgba(210,225,240,0.40)";
          ctx.fillRect(barrelW * 0.3, -barrelW / 2, barrelLen - barrelW * 0.3, barrelW * 0.28);
          // Muzzle tip glow — warm gold dot.
          ctx.fillStyle = "rgba(255,220,140,0.92)";
          ctx.beginPath();
          ctx.arc(barrelLen, 0, barrelW * 0.55, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }
    }
  }

  // Broadside gun ports — one muzzle dot per individual cannon module,
  // dimmed when that specific cannon is destroyed.
  if (ship.spec.firingMode === "broadside" && ship.modules) {
    for (const mod of ship.modules) {
      if (!mod.name.startsWith("broadside-")) continue;
      ctx.fillStyle = mod.disabled ? "rgba(60,30,20,0.7)" : tint;
      ctx.beginPath();
      ctx.arc(mod.offset.x * s.radius, mod.offset.y * s.radius, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // PD turrets — a powered tracking turret drawn at each turret's seated
  // module offset (coincident with its hit disc + firing origin). The art
  // slews to the turret's live aim; dead turrets show a soot crater.
  if (ship.spec.pdCannons) {
    const n = ship.spec.pdCannons.count;
    const ringR = s.radius * 0.75;   // fallback ring if a turret has no module
    for (let i = 0; i < n; i++) {
      const modName = ship.pdTurretModules ? ship.pdTurretModules[i] : ("pd-" + i);
      const mod = ship.moduleByName && ship.moduleByName[modName];
      const alive = !(mod && mod.disabled);
      let bx, by, mr;
      if (mod) { bx = mod.offset.x * s.radius; by = mod.offset.y * s.radius; mr = mod.radius * s.radius * 0.95; }
      else { const fa = (i / n) * Math.PI * 2; bx = Math.cos(fa) * ringR; by = Math.sin(fa) * ringR; mr = s.radius * 0.11; }
      if (!alive) {
        ctx.save(); ctx.translate(bx, by);
        ctx.fillStyle = "rgba(0,0,0,0.85)";
        ctx.beginPath(); ctx.arc(0, 0, mr * 0.9, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = "rgba(120,60,40,0.7)"; ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.arc(0, 0, mr * 0.9, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();
        continue;
      }
      // Aim: live target bearing if tracking, else rest pointing outward.
      const rest = Math.atan2(by, bx);
      const aimWorld = (ship.pdAimAngles && ship.pdAimAngles[i] != null)
        ? ship.pdAimAngles[i] : (ship.heading + rest);
      const frac = mod ? (mod.hp / mod.hpMax) : 1;
      ctx.save();
      ctx.translate(bx, by);
      drawPdArt(ctx, mr, ship, frac, aimWorld - ship.heading, detail);
      ctx.restore();
    }
  }

  // Heavy laser bow muzzle — small glowing lens dot with a faction-colored
  // outer halo so the forward emitter reads as a powered weapon.
  if (ship.spec.heavyLaser) {
    const laserDead = ship.moduleByName && ship.moduleByName.laser && ship.moduleByName.laser.disabled;
    const lx = s.radius * 0.95;
    if (!laserDead) {
      const [lr, lg, lb] = factionShieldRGB(ship.race);
      // Outer glow halo.
      ctx.fillStyle = `rgba(${lr},${lg},${lb},0.30)`;
      ctx.beginPath(); ctx.arc(lx, 0, 8, 0, Math.PI * 2); ctx.fill();
      // Mid ring.
      ctx.fillStyle = `rgba(${lr},${lg},${lb},0.60)`;
      ctx.beginPath(); ctx.arc(lx, 0, 5, 0, Math.PI * 2); ctx.fill();
    }
    // Core dot — white hot when alive, dark when dead.
    ctx.fillStyle = laserDead ? "rgba(50,25,25,0.80)" : "rgba(255,255,255,0.95)";
    ctx.beginPath(); ctx.arc(lx, 0, 3, 0, Math.PI * 2); ctx.fill();
  }

  // Module markers. Each module renders a type-specific icon inside its
  // hit disc (laser barrel, missile silos, broadside cannons, PD turret,
  // hangar bay, torpedo tube, engine nozzle) so the player can read at
  // a glance which systems are still online. Progressive chip-damage
  // chrome paints over the icon as HP drops:
  //   stage 0 (>80% hp)  pristine icon
  //   stage 1 (>55% hp)  hairline crack chord across the disc
  //   stage 2 (>30% hp)  stage 1 + chipped rim wedge + darker inner
  //   stage 3 (>0%  hp)  red-hot core gradient (also drives smoke VFX)
  //   stage 4 (=0% hp)   crater + soot ring (disabled)
  // Crack/wedge/core only paint when this ship's screen radius is >=12px
  // — far-zoomed-out ships in a 250-ship brawl skip them.
  if (ship.modules) {
    for (const m of ship.modules) {
      // PD turret modules render through the dedicated turret pass
      // above — they already show alive/dead state via the darkened
      // base + barrel. Skip the module-art layer here so we don't
      // paint a redundant octagonal disc on top of every turret.
      if (m.name.startsWith("pd-")) continue;
      const mx = m.offset.x * s.radius;
      const my = m.offset.y * s.radius;
      const mr = m.radius * s.radius * 0.85;
      if (m.disabled) {
        ctx.fillStyle = "rgba(0,0,0,0.85)";
        ctx.beginPath(); ctx.arc(mx, my, mr, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = "rgba(120,60,40,0.7)";
        ctx.lineWidth = 1.2;
        ctx.stroke();
        continue;
      }
      const frac = m.hp / m.hpMax;
      drawModuleArt(ctx, m, mx, my, mr, frac, ship, detail);
      if (detail) {
        // Deterministic angle seed from the module name so cracks/wedges
        // sit in the same place each frame without storing per-module state.
        let seed = 0;
        for (let i = 0; i < m.name.length; i++) seed = (seed * 31 + m.name.charCodeAt(i)) | 0;
        const crackAng = (seed & 0xffff) / 0xffff * Math.PI;
        if (frac <= 0.80) {
          // Stage 1+: hairline crack across the disc.
          const cx = Math.cos(crackAng) * mr * 0.95;
          const cy = Math.sin(crackAng) * mr * 0.95;
          ctx.strokeStyle = "rgba(20,20,25,0.85)";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(mx - cx, my - cy);
          ctx.lineTo(mx + cx, my + cy);
          ctx.stroke();
        }
        if (frac <= 0.55) {
          // Stage 2+: chipped wedge cut out of the rim + darker inner disc.
          ctx.fillStyle = "rgba(0,0,0,0.55)";
          ctx.beginPath();
          ctx.arc(mx, my, mr, crackAng + 1.9, crackAng + 2.5);
          ctx.lineTo(mx, my);
          ctx.closePath();
          ctx.fill();
          ctx.fillStyle = "rgba(80,40,30,0.45)";
          ctx.beginPath(); ctx.arc(mx, my, mr * 0.55, 0, Math.PI * 2); ctx.fill();
        }
        if (frac <= 0.30) {
          // Stage 3: red-hot core showing through the breached casing.
          const g = ctx.createRadialGradient(mx, my, 0, mx, my, mr);
          g.addColorStop(0, "rgba(255,210,120,0.95)");
          g.addColorStop(0.45, "rgba(255,110,40,0.7)");
          g.addColorStop(1, "rgba(255,40,20,0)");
          ctx.fillStyle = g;
          ctx.beginPath(); ctx.arc(mx, my, mr, 0, Math.PI * 2); ctx.fill();
        }
      }
      if (m.flash > 0) {
        ctx.strokeStyle = "rgba(255,255,255," + m.flash.toFixed(2) + ")";
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(mx, my, mr, 0, Math.PI * 2); ctx.stroke();
      }
    }
  }

  // Player indicator.
  if (ship.isPlayer) {
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(0, 0, s.radius + 6 + Math.sin(performance.now() / 200) * 1.5, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.restore();

  // Shield bubble. Faction-colored energy field with inner glow layer.
  // Flickers when critically low. Per-hit arc flares use the faction
  // color so impacts read as belonging to the ship's energy signature.
  if (ship.shieldMax > 0 && ship.shield > 0) {
    const frac = ship.shield / ship.shieldMax;
    const [sr, sg, sb] = factionShieldRGB(ship.race);

    // At < 25% shield capacity the bubble flickers — a half-period sine
    // gate keyed to performance.now() so it reads as flickering power.
    let flicker = 1;
    if (frac < 0.25) {
      flicker = 0.45 + 0.55 * Math.abs(Math.sin(performance.now() * 0.007 + ship.id * 1.7));
    }

    const baseAlpha = (0.06 + 0.20 * frac) * flicker;
    const alpha = Math.min(0.88, baseAlpha + ship.shieldFlash * flicker);

    const shieldOffset = Math.max(12, s.radius * 0.40);
    const bubbleR = s.radius + shieldOffset;

    // Inner glow fill — very faint radial gradient so the shield reads
    // as a volumetric energy field, not just an outline.
    const glowAlpha = (0.03 + 0.06 * frac) * flicker;
    if (glowAlpha > 0.005) {
      const glow = ctx.createRadialGradient(
        ship.pos.x, ship.pos.y, bubbleR * 0.70,
        ship.pos.x, ship.pos.y, bubbleR
      );
      glow.addColorStop(0, `rgba(${sr},${sg},${sb},0)`);
      glow.addColorStop(0.6, `rgba(${sr},${sg},${sb},${(glowAlpha * 0.4).toFixed(4)})`);
      glow.addColorStop(1, `rgba(${sr},${sg},${sb},${glowAlpha.toFixed(4)})`);
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(ship.pos.x, ship.pos.y, bubbleR + 4, 0, Math.PI * 2);
      ctx.fill();
    }

    // Main ring — faction color, width grows on hit-flash.
    ctx.strokeStyle = `rgba(${sr},${sg},${sb},${alpha.toFixed(3)})`;
    ctx.lineWidth = 1.5 + ship.shieldFlash * 4;
    ctx.beginPath();
    ctx.arc(ship.pos.x, ship.pos.y, bubbleR, 0, Math.PI * 2);
    ctx.stroke();

    // Secondary inner ring at half radius offset — very faint, gives
    // depth on large capital shields.
    if (frac > 0.15 && s.radius > 30) {
      ctx.strokeStyle = `rgba(${sr},${sg},${sb},${(alpha * 0.22).toFixed(3)})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(ship.pos.x, ship.pos.y, bubbleR - Math.max(4, s.radius * 0.08), 0, Math.PI * 2);
      ctx.stroke();
    }

    // Per-hit arc flares — faction-colored with a bright white core so
    // impacts read clearly regardless of the bubble's base opacity.
    if (ship.shieldHits && ship.shieldHits.length > 0) {
      for (const h of ship.shieldHits) {
        const t = h.ttl / h.maxTtl;
        const half = 0.38 * t + 0.10;
        const worldAng = ship.heading + h.ang;
        const a0 = worldAng - half;
        const a1 = worldAng + half;
        // Outer faction-colored flare.
        ctx.strokeStyle = `rgba(${sr},${sg},${sb},${(0.82 * t).toFixed(3)})`;
        ctx.lineWidth = 5 + 7 * t;
        ctx.beginPath();
        ctx.arc(ship.pos.x, ship.pos.y, bubbleR, a0, a1);
        ctx.stroke();
        // Bright white core line over the flare.
        ctx.strokeStyle = `rgba(255,255,255,${(0.65 * t).toFixed(3)})`;
        ctx.lineWidth = 1.5 + 2 * t;
        ctx.beginPath();
        ctx.arc(ship.pos.x, ship.pos.y, bubbleR, a0 + half * 0.25, a1 - half * 0.25);
        ctx.stroke();
      }
    }
  }

  // Armor bar REMOVED — armor is per-block / per-module now and reads
  // implicitly from the block grid (cells that survive a hit show the
  // armor working; cells that wink out show it failed).

  // Surrender marker — white flag sticking up out of the hull, drawn
  // in screen space (camera-aligned, not ship-rotated) so the flag
  // reads upright regardless of the surrendered ship's heading. Sits
  // above the HP bar so it doesn't fight the readout.
  if (ship.surrendered) {
    ctx.globalAlpha = 1.0;  // reset from the 0.55 dim earlier
    const flagY = -(ship.spec.radius + 24);
    const poleY = -(ship.spec.radius + 6);
    // Pole
    ctx.strokeStyle = "#ddd";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, poleY);
    ctx.lineTo(0, flagY - 2);
    ctx.stroke();
    // Flag — small white triangle
    ctx.fillStyle = "#fff";
    ctx.strokeStyle = "#888";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, flagY - 2);
    ctx.lineTo(12, flagY + 3);
    ctx.lineTo(0, flagY + 8);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
}
