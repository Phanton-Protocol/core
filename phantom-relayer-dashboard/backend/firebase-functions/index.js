"use strict";

/**
 * Firebase entrypoint for the relayer backend.
 *
 * We reuse the existing Express app from ../src/index and prevent that file from
 * starting its own HTTP listener by setting FIREBASE_FUNCTIONS.
 */
process.env.FIREBASE_FUNCTIONS = process.env.FIREBASE_FUNCTIONS || "1";

const { onRequest } = require("firebase-functions/v2/https");
const { app } = require("../src/index");

exports.relayerApi = onRequest(
  {
    region: "us-central1",
    timeoutSeconds: 540,
    memory: "2GiB",
    cors: true,
  },
  app
);
