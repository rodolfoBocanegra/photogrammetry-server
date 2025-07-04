const express = require('express');
const path = require('path')
const Docker = require('dockerode');
const { PassThrough } = require('stream')

const app = express();
const port = 3000;

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        message: 'Express server running',
    });
});

app.post('/process', async (req, res) => {
    try {
        const outputStream = new PassThrough()

    const options = {
      HostConfig: {
        AutoRemove: true  // limpia el contenedor al terminar
      }
    };
    outputStream.pipe(res)
    res.setHeader('Content-Type', 'text/plain');
    docker.run('hello-python', [], outputStream, options, (err, data, container) => {
      if (err) {
        console.error('Error corriendo el contenedor:', err);
        return res.status(500).end(`Error container: ${err.message}`);
      }

      outputStream.on('close', ()=> res.end())
    });

  } catch (err) {
    console.error('Error en /process:', err);
    res.status(500).send(err.message);
  }
})

app.listen(port, () => {
    console.log(`Server listening at http://localhost:${port}`);
});
