// server.js
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const https = require('https');
const xml2js = require('xml2js');
const util = require('util');

const parseStringAsync = util.promisify(new xml2js.Parser().parseString);

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(express.static('public')); // to serve index.html

const API_VERSION = '2024-01';

app.post('/run-bulk', async (req, res) => {
  const { store, token, namespace, key, value } = req.body;
  const axiosInstance = axios.create({
    baseURL: `https://${store}/admin/api/${API_VERSION}`,
    headers: {
      'X-Shopify-Access-Token': token,
      'Content-Type': 'application/json',
    },
  });

  async function getAllVariants() {
    let products = [];
    let pageInfo = null;

    do {
      const res = await axiosInstance.get('/products.json', {
        params: {
          limit: 250,
          ...(pageInfo ? { page_info: pageInfo } : {}),
        },
      });

      products = products.concat(res.data.products);

      const linkHeader = res.headers.link;
      if (linkHeader && linkHeader.includes('rel="next"')) {
        const match = linkHeader.match(/page_info=([^&>]+)/);
        pageInfo = match ? match[1] : null;
      } else {
        pageInfo = null;
      }
    } while (pageInfo);

    return products.flatMap(product =>
      product.variants.map(v => ({
        id: v.id,
        gid: `gid://shopify/ProductVariant/${v.id}`,
      }))
    );
  }

  function createJsonlFile(variants, filePath) {
    const stream = fs.createWriteStream(filePath);
    for (const variant of variants) {
      const mutationLine = {
        input: {
          ownerId: variant.gid,
          namespace,
          key,
          type: 'single_line_text_field',
          value,
        },
      };
      stream.write(JSON.stringify({ input: mutationLine.input }) + '\n');
    }
    stream.end();
  }

  async function getStagedUploadPath(xml) {
    try {
      const result = await parseStringAsync(xml);
      return result?.PostResponse?.Key?.[0] || null;
    } catch (err) {
      return null;
    }
  }

  async function uploadAndTriggerBulk(filePath) {
    const uploadRes = await axiosInstance.post('/graphql.json', {
      query: `mutation {
        stagedUploadsCreate(input: [{
          resource: BULK_MUTATION_VARIABLES,
          filename: "bulk_metafields.jsonl",
          mimeType: "text/jsonl",
          httpMethod: POST
        }]) {
          stagedTargets {
            url
            resourceUrl
            parameters { name value }
          }
          userErrors { field message }
        }
      }`,
    });

    const target = uploadRes.data.data.stagedUploadsCreate.stagedTargets[0];

    const form = new FormData();
    target.parameters.forEach(param => form.append(param.name, param.value));
    form.append('file', fs.createReadStream(filePath));

    const uploadResponse = await axios.post(target.url, form, {
      headers: form.getHeaders(),
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      timeout: 120000,
      httpsAgent: new https.Agent({ keepAlive: true }),
    });

    const stagedUploadPath = await getStagedUploadPath(uploadResponse.data);
    if (!stagedUploadPath) throw new Error('Could not parse stagedUploadPath');

    const mutation = `
      mutation bulkOperationRunMutation($stagedUploadPath: String!) {
        bulkOperationRunMutation(
          mutation: "mutation metafieldSet($input: MetafieldsSetInput!) { metafieldsSet(metafields: [$input]) { userErrors { field message } } }",
          stagedUploadPath: $stagedUploadPath
        ) {
          bulkOperation {
            id
            status
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const triggerRes = await axiosInstance.post('/graphql.json', {
      query: mutation,
      variables: { stagedUploadPath },
    });

    return triggerRes.data;
  }

  try {
    const filePath = path.join(__dirname, 'bulk_metafields.jsonl');
    const variants = await getAllVariants();
    createJsonlFile(variants, filePath);
    const result = await uploadAndTriggerBulk(filePath);
    res.send(`Bulk operation triggered. Operation ID: ${result.data.bulkOperationRunMutation.bulkOperation.id}`);
  } catch (err) {
    res.status(500).send(`Error: ${err.message}`);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));
