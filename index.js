const express = require('express');
const bodyParser = require('body-parser');

const serverless = require('serverless-http');

const routes = require('./routes');

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

app.use('/', routes);

module.exports.handler = serverless(app);
