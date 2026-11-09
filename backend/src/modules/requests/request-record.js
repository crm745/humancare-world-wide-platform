// The service_requests columns a validated request body fills in. Used by the request-first
// review workflow; it must stay the same as what createRequest (requests.service.js) writes, and
// a test (request-review.test.js) compares the two so they cannot drift apart.
function requestRecordData(userId, data) {
  const {
    serviceType, serviceKey, patientName, patientAge, patientGender, patientLocation, patientContact,
    origin, destination, originGeonameId, originCityName, originCountryCode, originTimezone,
    destinationGeonameId, destinationCityName, destinationCountryCode, country, preferredDate, careLevel,
    description, deceasedRelation, placeOfDeath, dateOfDeath, mobility, equipOxygen, equipCardiacMonitor,
    equipVentilator, urgency,
  } = data;
  return {
    userId,
    serviceType,
    serviceKey: serviceKey || null,
    patientName,
    patientAge: patientAge != null ? Number(patientAge) : null,
    patientGender: patientGender || null,
    patientLocation: patientLocation || null,
    patientContact: patientContact || null,
    origin,
    destination,
    originGeonameId: originGeonameId ?? null,
    originCityName: originCityName ?? null,
    originCountryCode: originCountryCode ?? null,
    originTimezone: originTimezone ?? null,
    destinationGeonameId: destinationGeonameId ?? null,
    destinationCityName: destinationCityName ?? null,
    destinationCountryCode: destinationCountryCode ?? null,
    country: country || null,
    preferredDate: preferredDate ? new Date(preferredDate) : null,
    careLevel: careLevel || null,
    description: description || null,
    deceasedRelation: deceasedRelation || null,
    placeOfDeath: placeOfDeath || null,
    dateOfDeath: dateOfDeath ? new Date(dateOfDeath) : null,
    mobility: mobility || null,
    equipOxygen: equipOxygen ?? null,
    equipCardiacMonitor: equipCardiacMonitor ?? null,
    equipVentilator: equipVentilator ?? null,
    urgency: urgency || null,
  };
}

module.exports = { requestRecordData };
