"use strict";

/**
 * Static registry of known seat IDs for this deployment. A real
 * install would generate this from however many desks/seats exist;
 * for Day 1 this is a plain array so the sweep and QR generator have
 * something concrete to iterate. Edit SEAT_IDS to match your space.
 */
const SEAT_IDS = ["A1", "A2", "A3", "B1", "B2", "B3"];

module.exports = { SEAT_IDS };
