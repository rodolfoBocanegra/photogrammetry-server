const express = require('express');
const logger = require('morgan');
const path = require('path')
const Docker = require('dockerode');
const { PassThrough } = require('stream')
const cors = require('cors')

const app = express();
app.use(express.json());
app.use(logger('dev'));
const port = 3000;

function configureCors() {
  let allowedOrigins = []
  if (process.env.ENVIRONMENT === 'local') {
    allowedOrigins.push('http://localhost:4200');
    allowedOrigins.push('http://localhost:30000');
  } else if (process.env.ENVIRONMENT === 'production') {
    if (!process.env.MAIN_SERVER_URL) {
      throw new Error('MAIN_SERVER_URL environment variable is required in production environment');
    }
    allowedOrigins.push(process.env.MAIN_SERVER_URL);
  } else {
    throw new Error('ENVIRONMENT must be set to either "local" or "production"');
  }
  app.use(cors({
    origin: allowedOrigins,
  }));
}

configureCors();
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
    res
      .status(200)
      .json({
        status: 'ok',
        message: 'Express server running',
    });
});

app.post('/process', async (req, res) => {
  try {
    // Basic validation of request body
    const {
      shouldBuild,
      imageName,
      photogrammetryId,
    } = req.body;
    if (shouldBuild !== undefined && typeof shouldBuild !== 'boolean') {
      return res.status(400).send("Request property 'shouldBuild' must be a boolean");
    }
    if (imageName !== undefined && typeof imageName !== 'string') {
      return res.status(400).send("Request property 'imageName' must be a string");
    }
    if (photogrammetryId !== undefined && typeof photogrammetryId !== 'string') {
      return res.status(400).send("Request property 'photogrammetryId' must be a string");
    }

    // Assign defaults
    const buildFlag = shouldBuild === true;
    const tag = imageName || 'photogrammetry-colmap';

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

    if (tag === 'photogrammetry-colmap-cuda') {
      // Bind input and output directories for CUDA-enabled image
      // this is the equivalent of the -v params in: `docker run -v /input:/data/images:ro -v /output:/data/output`
      options.HostConfig.Binds = [
        `${process.cwd()}/input:/data/images:ro`,
        `${process.cwd()}/output:/data/output`
      ];
      options.HostConfig.DeviceRequests = [
        {
          Driver: 'nvidia',
          Count: -1, // Use all available GPUs
          Capabilities: [['gpu']]
        }
      ];
    }

    if (options.Env.filter(entry => entry.includes('undefined')).length > 0) {
      console.error("Could not find values for all needed env vars, aborting photogrammetry process.")
      res.send(`Internal error, server is available but it could not start the photogrammetry process.`)
      return
    }

    // Handle stream errors
    outputStream.on('error', err => {
      console.error('Error in outputStream:', err);
      if (!res.headersSent) res.status(500);
      res.end(`Internal error: ${err.message}`);
    });

    outputStream.on('data', (data) => console.log(data.toString('utf-8')))

    // 3) Run the container using the dynamic tag
    const s3Prefix = photogrammetryId
    const args =
      tag === 'photogrammetry-colmap' ? [s3Prefix] : 
      tag === 'photogrammetry-colmap-cuda' ? ['/data/images', '/data/output']
      : []
    docker.run(tag, args, outputStream, options, (err, data) => {
        if (err) {
          console.error('Error while running container:', err);
          if (err.reason === 'no such container') {
            outputStream.end(`\n> Error: Container with tag "${tag}" does not exist in this server. Please build the image first.\n`);
          }
          outputStream.emit('error', err);
          return;
        }
        outputStream.end(`\n> Container exited with code ${data.StatusCode}\n`);
      }
    )
    .on('error', err => {
      console.error('Error in docker.run():', err);
      outputStream.emit('error', err);
    })
    .on('end', () => {
      console.log('Container run completed.');
      outputStream.end('\n> Process completed.\n');
      res.json({
        status: 'ok',
        message: 'Photogrammetry process completed successfully.',
        imageName: tag,
      });
    });

  } catch (err) {
    console.error('Error in /process:', err);
    if (!res.headersSent) res.status(500).send(err.message);
    else res.end(`Error: ${err.message}`);
  }
});

app.listen(port, () => {
    console.log(`Server listening at port: ${port}`);
});
