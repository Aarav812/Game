/**
 * collision.js
 * ------------
 * Collision filter groups shared by every physics body in the scene.
 *
 *   WORLD   static ground, buildings and props — collides with everything
 *   PLAYER  the on-foot character — collides with the world AND the car
 *   VEHICLE the car chassis — collides with the world AND the player
 *
 * The player and the car DO collide, so the car is solid to walk into. The
 * enter/exit sequence deliberately switches that pair off for a moment (see
 * Vehicle.setPlayerCollision and VehicleStateMachine) so the player is never
 * ejected by the solver while climbing in or stepping out.
 */

export const GROUP = {
  WORLD: 1,
  PLAYER: 2,
  VEHICLE: 4,
};

export const MASK = {
  WORLD: GROUP.WORLD | GROUP.PLAYER | GROUP.VEHICLE,
  PLAYER: GROUP.WORLD | GROUP.VEHICLE,
  VEHICLE: GROUP.WORLD | GROUP.PLAYER,
};
