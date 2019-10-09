const rp = require('request-promise');
const $ = require('cheerio');
const express = require('express');
const bodyParser = require('body-parser');

const serverless = require('serverless-http');

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

const AWS = require('aws-sdk');
// AWS.config.update({ region: 'REGION' });
const docClient = new AWS.DynamoDB.DocumentClient({ apiVersion: '2012-08-10' });

app.post('/price-match', (req, res) => {
  if (!req.body.url) {
    return res.status(400).send('URL is required');
  }

  if (!req.body.targetPrice) {
    return res.status(400).send('Target price is required');
  }

  rp(req.body.url)
    .then(html => {
      var title = $('#productTitle', html)
        .text()
        .trim();

      var price = $('[id=priceblock_ourprice],[id=priceblock_dealprice]', html)
        .text()
        .trim();
      price = price.replace(/[\u20B9]/g, '').trim();
      var floatPrice = parseFloat(price.replace(',', ''));

      const queryParams = {
        TableName: 'user-price-items',
        Item: {
          userId: 'baxishrey@gmail.com',
          tracked_items: [
            {
              url: req.body.url,
              targetPrice: floatPrice
            }
          ]
        }
      };

      docClient.put(queryParams, (err, data) => {
        if (err) {
          console.log('Error in creating record', err);
          return res.status(400).send('Could not enter data');
        } else {
          console.log(data);
        }
      });

      res.send({ title, currentPrice: floatPrice });
    })
    .catch(err => {
      console.log('Error in fetching', err);
      res.status(400).send(err);
    });
});

module.exports.handler = serverless(app);
