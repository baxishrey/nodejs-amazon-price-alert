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
  const url = req.body.url;
  const targetPrice = req.body.targetPrice;
  const username = req.body.username;

  if (!url) {
    return res.status(400).send('URL is required');
  }

  if (!targetPrice) {
    return res.status(400).send('Target price is required');
  }

  if (!username) {
    return res.status(400).send('Username is required');
  }

  getUser(username)
    .then(data => {
      if (!data.Item) {
        const newEntry = {
          username,
          url,
          targetPrice
        };
        return Promise.resolve(addNewEntry(newEntry));
      } else {
        let tracked_items = data.Item.tracked_items;
        const price = parseInt(targetPrice);
        tracked_items.push({ url, targetPrice: price });
        return Promise.resolve(updateEntry(username, tracked_items));
      }
    })
    .then(data => {
      res.send(data);
    })
    .catch(err => {
      console.log('Error in fetching', err);
      res.status(400).send(err);
    });
});

app.get('/user/:username/items', (req, res) => {
  const username = req.params.username;
  getUser(username).then(
    function(data) {
      const item = data.Item;
      if (item) {
        const tracked_items = Array.from(item.tracked_items);
        const promiseList = tracked_items.map(ti => {
          return rp(ti.url);
        });
        Promise.all(promiseList).then(htmls => {
          const retVal = htmls.map((html, index) => {
            var title = $('#productTitle', html)
              .text()
              .trim();

            var price = $(
              '[id=priceblock_ourprice],[id=priceblock_dealprice]',
              html
            )
              .text()
              .trim();
            price = price.replace(/[\u20B9]/g, '').trim();
            var currentPrice = parseFloat(price.replace(',', ''));
            return {
              title: title,
              currentPrice: currentPrice,
              targetPrice: tracked_items[index].targetPrice
            };
          });
          res.send(retVal);
        });
      } else {
        res.status(400).send('No tracked items found for this user');
      }
    },
    function(err) {
      res.status(400).send(err);
    }
  );
});

function getUser(username) {
  const params = {
    TableName: 'user-price-items',
    Key: {
      userId: username
    }
  };
  return docClient.get(params).promise();
}

function addNewEntry(newEntry) {
  const queryParams = {
    TableName: 'user-price-items',
    Item: {
      userId: newEntry.username,
      tracked_items: [
        {
          url: newEntry.url,
          targetPrice: newEntry.targetPrice
        }
      ]
    }
  };
  return docClient.put(queryParams).promise();
}

function updateEntry(username, updatedEntry) {
  const updateParams = {
    TableName: 'user-price-items',
    Key: { userId: username },
    UpdateExpression: 'SET #ti = :ti',
    ExpressionAttributeNames: { '#ti': 'tracked_items' },
    ExpressionAttributeValues: {
      ':ti': updatedEntry
    },
    ReturnValues: 'UPDATED_NEW'
  };
  return docClient.update(updateParams).promise();
}

module.exports.handler = serverless(app);
