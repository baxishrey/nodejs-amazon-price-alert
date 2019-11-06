var express = require('express');
var router = express.Router();
const uuid = require('uuid/v1');
const $ = require('cheerio');
const rp = require('request-promise');

const AWS = require('aws-sdk');
// AWS.config.update({ region: 'REGION' });
const docClient = new AWS.DynamoDB.DocumentClient({ apiVersion: '2012-08-10' });
const ecs = new AWS.ECS();

const cluster = 'node-price-alert-cluster';
const taskDefinition = 'node-price-alert-task-definition';
const launchType = 'FARGATE';

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
router.post('/track-item', async (req, res) => {
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
  let userData;
  try {
    userData = await getUser(username);
    if (!userData.Item) {
      const runTaskReponse = await startEcsTask(url, parseInt(targetPrice));
      const runningTaskId = runTaskReponse.tasks[0].taskArn;
      const newEntry = {
        id: uuid(),
        username,
        url,
        targetPrice: parseInt(targetPrice),
        runningTaskId
      };
      const newEntryInDb = await addNewEntry(newEntry);
      res.send(newEntryInDb);
    } else {
      let tracked_items = userData.Item.tracked_items;
      const price = parseInt(targetPrice);
      const runTaskReponse = await startEcsTask(url, price);
      const runningTaskId = runTaskReponse.tasks[0].taskArn;
      tracked_items.push({
        id: uuid(),
        url,
        targetPrice: price,
        runningTaskId
      });
      const data = await updateEntry(username, tracked_items);
      res.send(data);
    }
  } catch (err) {
    console.log('Error in fetching', err);
    res.status(400).send(err);
  }
});

// PUT
router.put('/user/:username/items/update/:id', async (req, res) => {
  const { username, id } = req.params;
  const { newTargetPrice } = req.body;
  if (!id) {
    res.status(400).send('Enter user Id');
  }
  if (!newTargetPrice) {
    return res.status(400).send('Enter new target price');
  }
  try {
    const data = await getUser(username);
    const user = data.Item;
    if (!user) {
      res.status(400).send('User not found');
    } else {
      const tracked_items = Array.from(user.tracked_items);
      const itemToUpdate = tracked_items.find(ti => ti.id === id);
      if (!itemToUpdate) {
        res.status(400).send('Item not found');
      } else {
        // Stop running task
        await stopEcsTask(itemToUpdate.runningTaskId);
        // Run new task
        const url = itemToUpdate.url;
        const targetPriceInt = parseInt(newTargetPrice);
        const runTaskReponse = await startEcsTask(url, targetPriceInt);
        const runningTaskId = runTaskReponse.tasks[0].taskArn;

        // Update DB entry
        itemToUpdate.targetPrice = targetPriceInt;
        itemToUpdate.runningTaskId = runningTaskId;
        const index = tracked_items.indexOf(itemToUpdate);
        tracked_items[index] = itemToUpdate;
        const data = await updateEntry(username, tracked_items);
        res.send(data);
      }
    }
  } catch (err) {
    res.status(400).send(err);
  }
});

// DELETE
router.delete('/user/:username/items/delete/:id', async (req, res) => {
  const { username, id } = req.params;
  if (!id) {
    res.status(400).send('Enter user Id');
  }
  try {
    const data = await getUser(username);
    const user = data.Item;
    if (!user) {
      res.status(400).send('User not found');
    } else {
      const tracked_items = Array.from(user.tracked_items);
      const itemToDelete = tracked_items.find(ti => ti.id === id);
      if (!itemToDelete) {
        res.status(400).send('Item not found');
      } else {
        // Stop running task
        const runningTaskId = itemToDelete.runningTaskId;
        await stopEcsTask(runningTaskId);

        // Remove entry from DB
        const new_tracked_items = tracked_items.filter(ti => ti.id !== id);
        const data = await updateEntry(username, new_tracked_items);
        res.send(data);
      }
    }
  } catch (err) {
    res.status(400).send(err);
  }
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

function startEcsTask(url, targetPrice) {
  const runTaskParams = {
    cluster: cluster,
    taskDefinition: taskDefinition,
    launchType: launchType,
    networkConfiguration: {
      awsvpcConfiguration: {
        subnets: ['subnet-0fda27a45e1443f69'],
        assignPublicIp: 'ENABLED'
      }
    },
    overrides: {
      containerOverrides: [
        {
          name: 'node-price-alert-container',
          environment: [
            { name: 'url', value: url },
            { name: 'targetPrice', value: targetPrice.toString() },
            { name: 'NODE_ENV', value: 'production' }
          ]
        }
      ]
    }
  };
  return ecs.runTask(runTaskParams).promise();
}

function stopEcsTask(taskArn) {
  const stopTaskParams = {
    task: taskArn,
    cluster: cluster
  };

  return ecs.stopTask(stopTaskParams).promise();
}

module.exports = router;
