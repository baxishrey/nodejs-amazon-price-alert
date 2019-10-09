const rp = require('request-promise');
const $ = require('cheerio');
const express = require('express');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

const port = process.env.PORT || 3000;

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

      res.send({ title, floatPrice });
    })
    .catch(err => {
      res.status(400).send(err);
    });
});

app.listen(port, () => {
  console.log(`Server started on port ${port}`);
});
