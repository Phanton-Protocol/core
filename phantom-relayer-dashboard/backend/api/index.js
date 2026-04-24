"use strict";

// Reuse the existing Express app exported by src/index.js.
// src/index.js already avoids app.listen() when VERCEL is present.
const { app } = require("../src/index");

module.exports = app;
