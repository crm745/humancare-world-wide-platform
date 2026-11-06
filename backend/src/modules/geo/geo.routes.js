const { Router } = require('express');
const { requireAuth } = require('../../common/middleware/auth.middleware');
const { geoSearchLimiter } = require('../../common/middleware/rate-limit.middleware');
const { getCities } = require('./geo.controller');

const geoRouter = Router();

// Patients only (the request form is theirs); limited per account because this is type-ahead.
geoRouter.get('/cities', requireAuth(['patient']), geoSearchLimiter, getCities);

module.exports = { geoRouter };
