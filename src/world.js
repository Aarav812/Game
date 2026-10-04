import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { loadModels } from './models.js';
import { Island } from './island.js';
import { RoadNetwork, GRID } from './network.js';
import { City } from './city.js';
import { AmbientNPCs } from './npcs.js';

/**
 * world.js
 * --------
 * Thin orchestration over three procedural generators:
 *
 *   island.js   the 2500 x 2500 landmass + endless ocean + land colliders
 *   network.js  arterials (6-lane elevated), boulevards (4-lane), locals (2-lane)
 *   city.js     the four macro-districts and every instanced building/prop
 *
 * Nothing in the world is a hardcoded block array; everything is derived from
 * the street grid and a zone function.
 */

export class World {
  constructor(scene) {
    this.scene = scene;
    this.models = null;
    this.island = null;
    this.network = null;
    this.city = null;

    this.physics = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82, 0) });
    this.physics.allowSleep = false;
    this.physics.solver.iterations = 10;
    // Hundreds of static bodies: SAP keeps the pair test near O(n log n).
    this.physics.broadphase = new CANNON.SAPBroadphase(this.physics);

    this.groundMaterial = new CANNON.Material('ground');
    this.physics.addContactMaterial(
      new CANNON.ContactMaterial(this.groundMaterial, this.groundMaterial, {
        friction: 0.6,
        restitution: 0,
      })
    );
    this.physics.defaultContactMaterial.friction = 0.5;
  }

  /** Generate the whole world. Call once, before the loop. */
  async load(onProgress) {
    this.models = await loadModels({ onProgress });

    // The road network first: it produces the respawn points the island wants.
    this.network = new RoadNetwork(this.scene, this.physics, this.groundMaterial);
    this.network.build();

    this.island = new Island(this.scene, this.physics, this.groundMaterial);
    this.island.build(this.network.respawn);

    this.city = new City(this.scene, this.physics, this.groundMaterial, this.models, this.network);
    this.city.build();

    this.npcs = new AmbientNPCs(this.scene, this.physics, { network: this.network, city: this.city });
    this.npcs.init();

    return this;
  }

  /** Water animation + ambient NPCs. Actors carry player/car focus each frame. */
  update(dt, actors = {}) {
    if (this.island) this.island.updateWater(dt);
    if (this.npcs) this.npcs.update(dt, actors);
  }

  /** Drain queued NPC alert events (e.g. pedestrian struck). */
  pollAlerts() {
    if (this.npcs) return this.npcs.pollAlerts();
    return [];
  }

  nearestRespawn(x, z) {
    return this.island.nearestRespawn(x, z);
  }

  isDrowned(y) {
    return this.island.isDrowned(y);
  }

  step(fixedDt) {
    this.physics.step(fixedDt);
  }

  /** Summary used by the verification tooling. */
  stats() {
    const npcStats = this.npcs ? this.npcs.stats() : { peds: 0, pedStates: {}, traffic: 0, trafficAvgKmh: 0 };
    return {
      buildings: this.city ? this.city.buildings.length : 0,
      chunkBodies: this.city ? this.city.chunkBodies : 0,
      bodies: this.physics.bodies.length,
      landBodies: this.island ? this.island.landBodies : 0,
      landCells: this.island ? this.island.landCells : 0,
      highwayColliders: this.network ? this.network.colliders.length : 0,
      piers: this.network ? this.network.pierInstances : 0,
      lamps: this.network ? this.network.lampInstances : 0,
      respawn: this.island ? this.island.respawnPoints.length : 0,
      grid: GRID,
      peds: npcStats.peds,
      pedStates: npcStats.pedStates,
      traffic: npcStats.traffic,
      trafficAvgKmh: npcStats.trafficAvgKmh,
    };
  }
}

export { GRID };
