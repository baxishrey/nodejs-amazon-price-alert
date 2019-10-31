var express = require('express');
var router = express.Router();
const uuid = require('uuid/v1');
const $ = require('cheerio');
const rp = require('request-promise');

const AWS = require('aws-sdk');
// AWS.config.update({ region: 'REGION' });
const docClient = new AWS.DynamoDB.DocumentClient({ apiVersion: '2012-08-10' });

const tableName = 'user-price-items';

// GET
router.get('/user/:username/items', (req, res) => {
  const { username } = req.params;
  getUser(username).then(
    function(data) {
      const item = data.Item;
      if (item) {
        const tracked_items = Array.from(item.tracked_items);
        const promiseList = tracked_items.map(ti => {
          return rp(ti.url, { gzip: true });
        });
        Promise.all(promiseList)
          .then(htmls => {
            const retVal = htmls.map((html, index) => {
              var title = $('[id=productTitle]', html)
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
                id: tracked_items[index].id,
                title: title,
                currentPrice: currentPrice,
                targetPrice: tracked_items[index].targetPrice
              };
            });
            res.send(retVal);
          })
          .catch(err => res.status(400).send(err));
      } else {
        res.status(400).send('No tracked items found for this user');
      }
    },
    function(err) {
      res.status(400).send(err);
    }
  );
});

// POST
router.post('/track-item', (req, res) => {
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
          id: uuid(),
          username,
          url,
          targetPrice: parseInt(targetPrice)
        };
        return Promise.resolve(addNewEntry(newEntry));
      } else {
        let tracked_items = data.Item.tracked_items;
        const price = parseInt(targetPrice);
        tracked_items.push({ id: uuid(), url, targetPrice: price });
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

// PUT
router.put('/user/:username/items/update/:id', (req, res) => {
  const { username, id } = req.params;
  const { newTargetPrice } = req.body;
  if (!id) {
    res.status(400).send('Enter user Id');
  }
  if (!newTargetPrice) {
    return res.status(400).send('Enter new target price');
  }
  getUser(username)
    .then(
      data => {
        const user = data.Item;
        if (!user) {
          res.status(400).send('User not found');
        } else {
          const tracked_items = Array.from(user.tracked_items);
          const itemToUpdate = tracked_items.find(ti => ti.id === id);
          if (!itemToUpdate) {
            res.status(400).send('Item not found');
          } else {
            itemToUpdate.targetPrice = parseInt(newTargetPrice);
            const index = tracked_items.indexOf(itemToUpdate);
            tracked_items[index] = itemToUpdate;
            return Promise.resolve(updateEntry(username, tracked_items));
          }
        }
      },
      err => {
        throw new Error(err);
      }
    )
    .then(data => res.send(data))
    .catch(err => res.status(400).send(err));
});

// DELETE
router.delete('/user/:username/items/delete/:id', (req, res) => {
  const { username, id } = req.params;
  if (!id) {
    res.status(400).send('Enter user Id');
  }
  getUser(username)
    .then(
      data => {
        const user = data.Item;
        if (!user) {
          res.status(400).send('User not found');
        } else {
          const tracked_items = Array.from(user.tracked_items);
          const itemToDelete = tracked_items.find(ti => ti.id === id);
          if (!itemToDelete) {
            res.status(400).send('Item not found');
          } else {
            const new_tracked_items = tracked_items.filter(ti => ti.id !== id);
            return Promise.resolve(updateEntry(username, new_tracked_items));
          }
        }
      },
      err => {
        throw new Error(err);
      }
    )
    .then(data => res.send(data))
    .catch(err => res.status(400).send(err));
});

function getUser(username) {
  const params = {
    TableName: tableName,
    Key: {
      userId: username
    }
  };
  return docClient.get(params).promise();
}

function addNewEntry(newEntry) {
  const queryParams = {
    TableName: tableName,
    Item: {
      userId: newEntry.username,
      tracked_items: [
        {
          id: newEntry.id,
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
    TableName: tableName,
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

module.exports = router;
