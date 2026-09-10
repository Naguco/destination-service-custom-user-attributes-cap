'use strict';

const axios = require('axios');
const { getUserToken, getServiceBinding, getDestination, buildHeadersForDestination, retrieveJwt } = require('@sap-cloud-sdk/connectivity');

module.exports = function () {
  this.on('inspectSamlViaExchange', async (req) => {
    const { destinationName } = req.data;

    const jwt = retrieveJwt(req._.req);
    if (!jwt) {
      return { error: 'No Authorization header found on incoming request.' };
    }
    console.log('[saml-inspector/exchange] User JWT received (length=%d)', jwt.length);

    try {
      const destination = await getDestination({ destinationName, jwt });
      if (!destination) {
        return { error: `Destination ${destinationName} not found` };
      }

      const token = destination.authTokens?.[0];
      if (!token) return { error: 'No authTokens in Destination Service response.' };
      if (token.error) return { error: `Destination token error: ${token.error} — ${token.errorDescription || ''}` };

      const raw = token.value || '';
      const tokenType = token.type || '';
      const decoded = raw ? Buffer.from(raw, 'base64').toString('utf8') : '';
      return { raw, decoded, tokenType };

    } catch (err) {
      console.error('[saml-inspector/exchange] Error:', err.message);
      return { error: err.message };
    }
  });

};
