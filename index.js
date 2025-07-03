const express = require('express');

const app = express();
const port = 3000;

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        message: 'Express server running',
    });
});

app.listen(port, () => {
    console.log(`Server listening at http://localhost:${port}`);
});
