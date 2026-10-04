import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

/**
 * models.js
 * ---------
 * Loads every city asset as GLTF and hands out instances of them.
 *
 * Two sources feed the same pipeline:
 *   - Kenney "City Kit" models (CC0), copied into /public/models
 *   - the curved models authored by tools/generate-models.mjs (domes, arches,
 *     rounded corners, barrels, spiral tower) in /public/models/custom
 *
 * Instances are cloned templates. Because all assets are authored at a known
 * height and centred on XZ with their base at y = 0, callers simply ask for a
 * target height and the scale is derived.
 */

const BASE = '/models';

/** key -> url. */
export const MODEL_URLS = {
  // --- Kenney City Kit (Commercial), CC0 -----------------------------------
  'bldg-a': `${BASE}/commercial/building-a.glb`,
  'bldg-b': `${BASE}/commercial/building-b.glb`,
  'bldg-c': `${BASE}/commercial/building-c.glb`,
  'bldg-d': `${BASE}/commercial/building-d.glb`,
  'bldg-e': `${BASE}/commercial/building-e.glb`,
  'bldg-f': `${BASE}/commercial/building-f.glb`,
  'bldg-g': `${BASE}/commercial/building-g.glb`,
  'bldg-h': `${BASE}/commercial/building-h.glb`,
  'bldg-i': `${BASE}/commercial/building-i.glb`,
  'bldg-j': `${BASE}/commercial/building-j.glb`,
  'bldg-k': `${BASE}/commercial/building-k.glb`,
  'bldg-l': `${BASE}/commercial/building-l.glb`,
  'bldg-m': `${BASE}/commercial/building-m.glb`,
  'bldg-n': `${BASE}/commercial/building-n.glb`,
  'tower-a': `${BASE}/commercial/building-skyscraper-a.glb`,
  'tower-b': `${BASE}/commercial/building-skyscraper-b.glb`,
  'tower-c': `${BASE}/commercial/building-skyscraper-c.glb`,
  'tower-d': `${BASE}/commercial/building-skyscraper-d.glb`,
  'wide-a': `${BASE}/commercial/low-detail-building-wide-a.glb`,
  'wide-b': `${BASE}/commercial/low-detail-building-wide-b.glb`,
  awning: `${BASE}/commercial/detail-awning.glb`,
  overhang: `${BASE}/commercial/detail-overhang.glb`,
  parasol: `${BASE}/commercial/detail-parasol-a.glb`,

  // --- Kenney City Kit (Industrial), CC0 -----------------------------------
  container: `${BASE}/industrial/shipping-container-a.glb`,
  'container-b': `${BASE}/industrial/shipping-container-b.glb`,
  'water-tower': `${BASE}/industrial/water-tower.glb`,
  tank: `${BASE}/industrial/detail-tank-large.glb`,
  chimney: `${BASE}/industrial/chimney-medium.glb`,

  // --- Curved models authored for this scene -------------------------------
  dome: `${BASE}/custom/dome-landmark.gltf`,
  spiral: `${BASE}/custom/spiral-tower.gltf`,
  'round-shop': `${BASE}/custom/round-shop.gltf`,
  'arched-apartment': `${BASE}/custom/arched-apartment.gltf`,
  'curved-hall': `${BASE}/custom/curved-hall.gltf`,
  // District models: suburban housing, industrial sheds, dockyard cranes.
  house: `${BASE}/custom/house.gltf`,
  warehouse: `${BASE}/custom/warehouse.gltf`,
  crane: `${BASE}/custom/crane.gltf`,
  // Northern town.
  'gas-station': `${BASE}/custom/gas-station.gltf`,
  motel: `${BASE}/custom/motel.gltf`,
  // Macro-district filler.
  parking: `${BASE}/custom/parking.gltf`,
  diner: `${BASE}/custom/diner.gltf`,
  tree: `${BASE}/custom/tree.gltf`,
  pine: `${BASE}/custom/pine.gltf`,
  bin: `${BASE}/custom/bin.gltf`,
  lamp: `${BASE}/custom/lamp.gltf`,
  hydrant: `${BASE}/custom/hydrant.gltf`,
};

/**
 * The player character: a rigged, animated casual human — no weapons.
 *
 * Quaternius "Casual Hoodie" (CC0), from the Urban/Modular character line:
 * purple hoodie, dark trousers, white sneakers, hair and eyes as separate
 * meshes. It ships its OWN 24 animation clips on its own 62-bone skeleton, so
 * the mixer plays Idle / Walk / Run natively — this project does no cross-rig
 * retargeting anywhere.
 *
 * There is no jump clip, so the state machine holds a locomotion pose airborne.
 */
export const CHARACTER = {
  url: `${BASE}/characters/character.glb`,
  height: 1.8,
  clips: {
    idle: 'Idle',
    walk: 'Walk',
    run: 'Run',
    // Jump is used ONLY if the file actually ships a clip with this exact name.
    // This character does not, and there is deliberately no fallback pose: a
    // missing Jump clip means the Walk/Run cycle simply keeps playing while the
    // character is airborne. No bone is ever rewritten by hand.
    jump: 'Jump',
  },
  material: { roughness: 0.7, metalness: 0.1 },
  // Any mesh whose name or material matches this is a held item and is stripped
  // on load. This model has none, but the guard keeps weapons out if swapped.
  heldItemPattern: /sword|blade|gun|weapon|axe|bow|shield|knife|dagger|pistol|rifle|staff|wand|scabbard|holster/i,
};

/**
 * The car: Kenney "Car Kit" hatchback (CC0).
 *
 * The GLB ships the body and all four wheels as separate nodes, which the
 * runtime drives from the RaycastVehicle wheel transforms. `model` holds the
 * source measurements used to derive the physics wheel positions.
 */
export const CAR = {
  url: `${BASE}/car/hatchback-sports.glb`,
  length: 4.0,          // target world length (metres)
  model: {              // as authored in the GLB
    length: 2.85,       // along +Z
    wheelRadius: 0.3,
    wheelX: 0.425,      // hub offset from centre
    wheelZ: 0.81,       // front/rear hub offset
    hubY: 0.3,          // hub height above the model's ground plane
  },
};

/**
 * Named building types. `pool` lists candidate model keys; each placed instance
 * picks from the pool (deterministically, so the city is stable between runs).
 * `props` are attached around the base, `height` is the target world height.
 */
export const BUILDING_TYPES = {
  Shop: {
    pool: ['round-shop', 'bldg-a', 'bldg-b', 'bldg-e'],
    height: [9, 13],
    props: [{ key: 'awning', y: 3.2, forward: 0.55, height: 1.6 }],
  },
  Apartment: {
    pool: ['arched-apartment', 'bldg-c', 'bldg-d', 'bldg-f', 'bldg-g', 'bldg-h'],
    height: [14, 22],
    props: [],
  },
  'Office Tower': {
    pool: ['tower-a', 'tower-b', 'tower-c', 'tower-d'],
    height: [30, 46],
    props: [],
  },
  Cafe: {
    pool: ['bldg-i', 'bldg-j', 'round-shop'],
    height: [8, 11],
    props: [
      { key: 'parasol', y: 0, forward: 1.0, right: 1.4, height: 2.6 },
      { key: 'parasol', y: 0, forward: 1.0, right: -1.4, height: 2.6 },
    ],
  },
  Warehouse: {
    pool: ['curved-hall', 'wide-b', 'bldg-k'],
    height: [10, 15],
    props: [],
  },
  'Gas Station': {
    pool: ['gas-station'],
    height: [5.2, 6.0],
    props: [],
  },
  'Container Yard': {
    pool: ['bldg-l', 'bldg-m'],
    height: [7, 10],
    props: [
      { key: 'container', y: 0, right: 3.6, forward: -1.5, height: 2.4 },
      { key: 'container-b', y: 2.6, right: 3.6, forward: -1.5, height: 2.4 },
    ],
  },
  'Water Tower': {
    pool: ['bldg-n'],
    height: [9, 12],
    props: [{ key: 'water-tower', y: 0, right: 4.0, forward: 0, height: 11 }],
  },
  Factory: {
    pool: ['bldg-m', 'wide-b', 'curved-hall'],
    height: [11, 16],
    props: [{ key: 'chimney', y: 0, right: -3.2, forward: -1.2, height: 12 }],
  },

  // --- Island districts -----------------------------------------------------
  Residential: {
    pool: ['house'],
    height: [5.2, 7.4],
    props: [],
  },
  Industrial: {
    pool: ['warehouse'],
    height: [8.5, 12.5],
    props: [
      { key: 'container', y: 0, right: 7.6, forward: -1.9, height: 2.6 },
      { key: 'container-b', y: 2.75, right: 7.6, forward: -1.9, height: 2.6 },
    ],
  },
  // --- Northern suburban / desert town ---------------------------------------
  Motel: {
    pool: ['motel'],
    height: [6.4, 7.2],
    props: [],
  },
  Parking: {
    pool: ['parking'],
    height: [18, 26],
    props: [],
  },
  Diner: {
    pool: ['diner'],
    height: [5.6, 7.0],
    props: [],
  },
  Townhouse: {
    pool: ['house'],
    height: [4.8, 6.6],
    props: [],
  },
  'Town Warehouse': {
    pool: ['warehouse'],
    height: [7.5, 10],
    props: [],
  },
  'Dock Crane': {
    pool: ['crane'],
    height: [17, 21],
    props: [],
  },
};

// ---------------------------------------------------------------------------

/** Load every model. Returns Map<key, {template, size, center}>. */
export async function loadModels({ onProgress } = {}) {
  const loader = new GLTFLoader();
  const keys = Object.keys(MODEL_URLS);
  const loaded = new Map();
  let done = 0;

  await Promise.all(
    keys.map(async (key) => {
      const gltf = await loader.loadAsync(MODEL_URLS[key]);
      const template = gltf.scene;
      template.traverse((o) => {
        if (o.isMesh) {
          o.castShadow = true;
          o.receiveShadow = true;
          // Kenney models are double-sided in places; keep it cheap where we can.
          if (o.material) o.material.shadowSide = THREE.FrontSide;
        }
      });
      const box = new THREE.Box3().setFromObject(template);
      const size = box.getSize(new THREE.Vector3());
      loaded.set(key, { template, box, size, center: box.getCenter(new THREE.Vector3()) });
      done++;
      if (onProgress) onProgress(done / keys.length, key);
    })
  );

  return loaded;
}

/**
 * Clone a model into the scene.
 * @param loaded  Map from loadModels()
 * @param key     model key
 * @param opts    { position, rotationY, height, castShadow }
 * @returns { object, footprint } footprint = { halfX, halfZ, height } in world units
 */
export function spawn(loaded, key, opts = {}) {
  const entry = loaded.get(key);
  if (!entry) throw new Error(`model "${key}" was not loaded`);

  const object = entry.template.clone(true);
  const { position = new THREE.Vector3(), rotationY = 0, height = null } = opts;

  const scale = height ? height / Math.max(entry.size.y, 1e-6) : opts.scale ?? 1;
  object.scale.setScalar(scale);
  object.position.set(position.x, position.y, position.z);
  object.rotation.y = rotationY;
  object.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });

  const footprint = {
    halfX: (entry.size.x * scale) / 2,
    halfZ: (entry.size.z * scale) / 2,
    height: entry.size.y * scale,
  };

  return { object, footprint };
}

/** Random-from-pool helper that is stable for a given seed. */
export function pickFromPool(pool, seed) {
  const i = Math.abs(Math.floor(seed)) % pool.length;
  return pool[i];
}
