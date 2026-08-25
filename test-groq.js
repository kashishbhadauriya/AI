require("dotenv").config();

const Groq = require("groq-sdk");

const groq = new Groq({
    apiKey: process.env.GROQ_API_KEY
});

async function test() {
    try {
        const models = await groq.models.list();

        console.log("SUCCESS!");
        console.log("Available models:");

        models.data.forEach(model => {
            console.log(model.id);
        });

    } catch (error) {
        console.log("ERROR:");
        console.log(error.message);
    }
}

test();