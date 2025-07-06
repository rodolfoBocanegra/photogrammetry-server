const express = require('express');
const path = require('path')
const Docker = require('dockerode');
const { PassThrough } = require('stream')
const cors = require('cors')

const app = express();
app.use(express.json());
app.use(cors({ origin: 'http://localhost:4200' })) // TODO: enable only if in local env
const port = 3000;

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

/**
 * Builds the specified Docker image if shouldBuild === true.
 * @param {string} tag - The image tag to build.
 * @param {boolean} shouldBuild
 */
async function buildImageIfNeeded(tag, shouldBuild) {
  if (!shouldBuild) return;

  const context = path.resolve(__dirname);
  console.log(`Starting build of the ${tag} image...`);
  const buildStream = await docker.buildImage(
    { context, src: ['Dockerfile'] },
    { t: tag }
  );

  return new Promise((resolve, reject) => {
    docker.modem.followProgress(buildStream, (err, output) => {
      if (err) return reject(err);
      console.log('Build completed.');
      resolve(output);
    });
  });
}

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        message: 'Express server running',
    });
});

app.post('/process', async (req, res) => {
  try {
    // Basic validation of request body
    const { shouldBuild, imageName } = req.body;
    if (shouldBuild !== undefined && typeof shouldBuild !== 'boolean') {
      return res.status(400).send("Request property 'shouldBuild' must be a boolean");
    }
    if (imageName !== undefined && typeof imageName !== 'string') {
      return res.status(400).send("Request property 'imageName' must be a string");
    }

    // Assign defaults
    const buildFlag = shouldBuild === true;
    const tag = imageName || 'hello-python';

    // Set plain text response headers
    res.setHeader('Content-Type', 'text/plain');

    // 1) Optionally build the image with dynamic tag
    await buildImageIfNeeded(tag, buildFlag);

    // 2) Create output stream and pipe to response
    const outputStream = new PassThrough();
    outputStream.pipe(res);

    // Container options
    const options = {
      HostConfig: {
        AutoRemove: true,
      },
      Env: [
        `ENVIRONMENT=${process.env.ENVIRONMENT}`,
        `S3_REGION=${process.env.S3_REGION}`,
        `S3_ACCESS_KEY_ID=${process.env.S3_ACCESS_KEY_ID}`,
        `S3_SECRET_ACCESS_KEY=${process.env.S3_SECRET_ACCESS_KEY}`,
        `S3_BUCKET=${process.env.S3_BUCKET}`
      ]
    };

    if (options.Env.filter(entry => entry.includes('undefined')).length > 0) {
      console.err("Could not find values for all needed env vars")
    }

    // Handle stream errors
    outputStream.on('error', err => {
      console.error('Error in outputStream:', err);
      if (!res.headersSent) res.status(500);
      res.end(`Internal error: ${err.message}`);
    });

    outputStream.on('data', (data) => console.log(data.toString('utf-8')))

    // 3) Run the container using the dynamic tag
    const s3Prefix = 'test1235' // Using as default prefix for debugging
    const args = [s3Prefix]
    docker.run(tag, args, outputStream, options, (err, data) => {
        if (err) {
          console.error('Error while running container:', err);
          outputStream.emit('error', err);
          return;
        }
        outputStream.end(`\n> Container exited with code ${data.StatusCode}\n`);
      }
    ).on('error', err => {
      console.error('Error in docker.run():', err);
      outputStream.emit('error', err);
    });

  } catch (err) {
    console.error('Error in /process:', err);
    if (!res.headersSent) res.status(500).send(err.message);
    else res.end(`Error: ${err.message}`);
  }
});

app.listen(port, () => {
    console.log(`Server listening at http://localhost:${port}`);
});
