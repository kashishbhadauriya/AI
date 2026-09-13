require("dotenv").config();

const fs = require("fs");
const express = require("express");
const mongoose = require("mongoose");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const Groq = require("groq-sdk");
const Tesseract = require("tesseract.js");
const sharp = require("sharp");
const bcrypt = require("bcrypt");
const session = require("express-session");

// Models
const User = require("./models/user");
const Summary = require("./models/summary");
const Quiz = require("./models/quiz");
const Doubt = require("./models/Doubt");
const Flashcard = require("./models/flashcard");
const chat = require("./models/chat");
const DocumentChunk = require("./models/documentChunk");

// Hugging Face
const { InferenceClient } = require("@huggingface/inference");

// ======================================================
// APP SETUP
// ======================================================

const app = express();
const port = 3000;

app.set("view engine", "ejs");
app.set("views", "./views");

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

// ======================================================
// MULTER
// ======================================================

const upload = multer({
  storage: multer.memoryStorage()
});

// ======================================================
// MONGODB CONNECTION
// ======================================================

const dbURI = process.env.MONGO_URI;

mongoose
  .connect(dbURI)
  .then(() => {
    console.log("MongoDB connected successfully");
  })
  .catch((err) => {
    console.error("MongoDB connection error:", err);
  });

// ======================================================
// GROQ
// ======================================================

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY
});

// ======================================================
// HUGGING FACE
// ======================================================

const hf = new InferenceClient(
  process.env.HF_TOKEN
);

const EMBEDDING_MODEL =
  "thenlper/gte-large";

// ======================================================
// SESSION
// ======================================================

app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,

    cookie: {
      httpOnly: true,
      secure: false,
      sameSite: "lax",
      maxAge: 24 * 60 * 60 * 1000
    }
  })
);

// ======================================================
// AUTHENTICATION MIDDLEWARE
// ======================================================

function isLoggedIn(req, res, next) {

  if (req.session.userId) {
    next();
  } else {
    res.render("login", {
      error: "⚠️ Please login first."
    });
  }
}

// ======================================================
// HUGGING FACE EMBEDDING FUNCTION
// ======================================================

async function getEmbedding(text) {

  try {

    const result =
      await hf.featureExtraction({

        model: EMBEDDING_MODEL,

        inputs: text
      });

    /*
      Hugging Face can return:

      [0.1, 0.2, ...]

      or

      [[0.1, 0.2, ...]]
    */

    if (
      Array.isArray(result) &&
      Array.isArray(result[0])
    ) {

      return result[0];

    }

    return result;

  } catch (error) {

    console.error(
      "Hugging Face Embedding Error:",
      error
    );

    throw error;
  }
}

// ======================================================
// TEXT CHUNKING
// ======================================================

function chunkText(
  text,
  chunkSize = 1000,
  overlap = 200
) {

  const words =
    text.split(/\s+/);

  const chunks = [];

  let start = 0;

  while (start < words.length) {

    const end =
      Math.min(
        start + chunkSize,
        words.length
      );

    const chunk =
      words
        .slice(start, end)
        .join(" ");

    if (chunk.trim()) {

      chunks.push(
        chunk.trim()
      );
    }

    if (end === words.length) {
      break;
    }

    start =
      end - overlap;
  }

  return chunks;
}

// ======================================================
// PROCESS DOCUMENT FOR RAG
// ======================================================

async function processAndStoreDocument({
  text,
  filename,
  userId,
  documentId
}) {

  try {

    // --------------------------------------------------
    // 1. Split document into chunks
    // --------------------------------------------------

    const chunks =
      chunkText(
        text,
        1000,
        200
      );

    console.log(
      "Total chunks:",
      chunks.length
    );

    const documents = [];

    // --------------------------------------------------
    // 2. Generate embeddings
    // --------------------------------------------------

    for (
      let i = 0;
      i < chunks.length;
      i++
    ) {

      const chunk =
        chunks[i];

      console.log(
        `Creating embedding ${i + 1}/${chunks.length}`
      );

      const embedding =
        await getEmbedding(chunk);

      console.log(
        "Embedding dimensions:",
        embedding.length
      );

      /*
        IMPORTANT:

        MongoDB index is configured
        for 1024 dimensions.

        Therefore this should print:

        1024
      */

      if (
        embedding.length !== 1024
      ) {

        throw new Error(
          `Embedding dimension mismatch. Expected 1024 but received ${embedding.length}`
        );
      }

      documents.push({

        user: userId,

        documentId:
          documentId,

        filename:
          filename,

        text:
          chunk,

        embedding:
          embedding
      });
    }

    // --------------------------------------------------
    // 3. Save chunks into MongoDB
    // --------------------------------------------------

    await DocumentChunk.insertMany(
      documents
    );

    console.log(
      `Successfully stored ${documents.length} document chunks`
    );

    return documents.length;

  } catch (error) {

    console.error(
      "Document processing error:",
      error
    );

    throw error;
  }
}

// ======================================================
// RETRIEVE RELEVANT DOCUMENT CHUNKS
// ======================================================

async function retrieveRelevantChunks(
  question,
  userId,
  limit = 5
) {

  // --------------------------------------------------
  // 1. Create embedding for user question
  // --------------------------------------------------

  const queryEmbedding =
    await getEmbedding(question);

  console.log(
    "Query embedding dimensions:",
    queryEmbedding.length
  );

  // --------------------------------------------------
  // 2. Vector search
  // --------------------------------------------------

  const results =
    await DocumentChunk.aggregate([

      {
        $vectorSearch: {

          index:
             "autoembed_index",

          path:
            "embedding",

          queryVector:
            queryEmbedding,

          numCandidates:
            50,

          limit:
            limit,

          filter: {

            user:
              new mongoose.Types.ObjectId(
                userId
              )
          }
        }
      },

      {
        $project: {

          _id: 0,

          text: 1,

          filename: 1,

          documentId: 1,

          score: {

            $meta:
              "vectorSearchScore"
          }
        }
      }

    ]);

  return results;
}

// ======================================================
// BUILD CONTEXT
// ======================================================

function buildContext(results) {

  return results
    .map(
      (result, index) => {

        return `
DOCUMENT CHUNK ${index + 1}

${result.text}
`;
      }
    )
    .join("\n");
}

// ======================================================
// LOGIN
// ======================================================

app.get(
  "/login",
  (req, res) => {

    res.render(
      "login",
      {
        error: null
      }
    );
  }
);

// ======================================================
// HOME
// ======================================================

app.get(
  "/",
  (req, res) => {

    if (
      req.session.userId
    ) {

      return res.redirect(
        "/dashboard"
      );
    }

    res.render("login");
  }
);

// ======================================================
// SIGNUP PAGE
// ======================================================

app.get(
  "/signup",
  (req, res) => {

    res.render(
      "signup",
      {
        error: null
      }
    );
  }
);

// ======================================================
// LOGIN POST
// ======================================================

app.post(
  "/login",
  async (req, res) => {

    try {

      const {
        username,
        password
      } = req.body;

      const user =
        await User.findOne({
          username
        });

      if (!user) {

        return res.render(
          "login",
          {
            error:
              "⚠️ User not found. Please sign up first."
          }
        );
      }

      const match =
        await bcrypt.compare(
          password,
          user.password
        );

      if (!match) {

        return res.render(
          "login",
          {
            error:
              "⚠️ Incorrect password. Try again."
          }
        );
      }

      req.session.userId =
        user._id;

      res.redirect(
        "/dashboard"
      );

    } catch (error) {

      console.error(error);

      res.render(
        "login",
        {
          error:
            "Something went wrong."
        }
      );
    }
  }
);

// ======================================================
// SIGNUP POST
// ======================================================

app.post(
  "/signup",
  async (req, res) => {

    try {

      const {
        username,
        email,
        password
      } = req.body;

      const existingUser =
        await User.findOne({
          email
        });

      if (existingUser) {

        return res.render(
          "signup",
          {
            error:
              "⚠️ Email already registered. Please login."
          }
        );
      }

      const hashedPassword =
        await bcrypt.hash(
          password,
          10
        );

      const newUser =
        new User({

          username,

          email,

          password:
            hashedPassword
        });

      await newUser.save();

      req.session.userId =
        newUser._id;

      res.redirect(
        "/dashboard"
      );

    } catch (error) {

      console.error(error);

      res.render(
        "signup",
        {
          error:
            "Something went wrong."
        }
      );
    }
  }
);

// ======================================================
// DASHBOARD
// ======================================================

app.get(
  "/dashboard",
  isLoggedIn,
  (req, res) => {

    res.render(
      "dashboard"
    );
  }
);

// ======================================================
// SUMMARY PAGE
// ======================================================

app.get(
  "/summarize",
  isLoggedIn,
  async (req, res) => {

    try {

      const summary =
        await Summary.findOne({
          user:
            req.session.userId
        })
        .sort({
          createdAt: -1
        });

      res.render(
        "summarize",
        {
          summary: null
        }
      );

    } catch (error) {

      console.error(error);

      res.render(
        "summarize",
        {
          summary: null
        }
      );
    }
  }
);

// ======================================================
// SUMMARY POST
// ======================================================

app.post(
  "/summarize",
  isLoggedIn,
  upload.single("file"),

  async (req, res) => {

    try {

      let text = "";

      if (!req.file) {

        return res.send(
          "No file uploaded"
        );
      }

      const fileBuffer =
        req.file.buffer;

      const fileType =
        req.file.mimetype;

      // ------------------------------------------------
      // PDF
      // ------------------------------------------------

      if (
        fileType ===
        "application/pdf"
      ) {

        const data =
          await pdfParse(
            fileBuffer
          );

        text =
          data.text;
      }

      // ------------------------------------------------
      // IMAGE
      // ------------------------------------------------

      else if (
        fileType.startsWith(
          "image/"
        )
      ) {

        console.log(
          "Image detected"
        );

        const processedImage =
          await sharp(fileBuffer)

            .resize({
              width: 2000,
              withoutEnlargement:
                false
            })

            .grayscale()

            .normalize()

            .sharpen()

            .threshold(160)

            .png()

            .toBuffer();

        console.log(
          "Image preprocessing completed"
        );

        const result =
          await Tesseract.recognize(
            processedImage,
            "eng"
          );

        text =
          result.data.text;
      }

      else {

        return res.send(
          "Unsupported file format"
        );
      }

      // ------------------------------------------------
      // Chunk summary
      // ------------------------------------------------

      function summaryChunks(
        text,
        chunkSize = 4000
      ) {

        const chunks = [];

        for (
          let i = 0;
          i < text.length;
          i += chunkSize
        ) {

          chunks.push(
            text.slice(
              i,
              i + chunkSize
            )
          );
        }

        return chunks;
      }

      const chunks =
        summaryChunks(
          text,
          4000
        );

      console.log(
        "Total characters:",
        text.length
      );

      console.log(
        "Number of chunks:",
        chunks.length
      );

      const summaries = [];

      for (
        const [index, chunk]
        of chunks.entries()
      ) {

        console.log(
          `Processing chunk ${index + 1}`
        );

        const completion =
          await groq.chat.completions.create({

            model:
              "openai/gpt-oss-120b",

            messages: [

              {

                role:
                  "user",

                content: `
Summarize this part of the document in short bullet points:

${chunk}
`
              }

            ]
          });

        const chunkSummary =
          completion
            .choices[0]
            .message
            .content;

        summaries.push(
          chunkSummary
        );
      }

      const summary =
        summaries.join("\n");

      await Summary.create({

        filename:
          req.file.originalname,

        originalText:
          text,

        user:
          req.session.userId,

        summary:
          summary
      });

      res.render(
        "summarize",
        {
          summary:
            summary
        }
      );

    } catch (error) {

      console.error(error);

      res.send(
        "Error summarizing file"
      );
    }
  }
);

// ======================================================
// QUIZ PAGE
// ======================================================

app.get(
  "/quiz",
  isLoggedIn,
  async (req, res) => {

    try {

      const quiz =
        await Quiz.findOne({
          user:
            req.session.userId
        })
        .sort({
          createdAt: -1
        });

      res.render(
        "quiz",
        {
          quiz: null
        }
      );

    } catch (error) {

      console.error(error);

      res.render(
        "quiz",
        {
          quiz: null
        }
      );
    }
  }
);

// ======================================================
// QUIZ POST
// ======================================================

app.post(
  "/quiz",
  isLoggedIn,
  upload.single("file"),

  async (req, res) => {

    try {

      if (!req.file) {

        return res.send(
          "No file uploaded"
        );
      }

      const fileBuffer =
        req.file.buffer;

      const pdfData =
        await pdfParse(
          fileBuffer
        );

      const text =
        pdfData.text;

      const chunkSize =
        4000;

      const chunks = [];

      for (
        let i = 0;
        i < text.length;
        i += chunkSize
      ) {

        chunks.push(
          text.substring(
            i,
            i + chunkSize
          )
        );
      }

      console.log(
        "Total characters:",
        text.length
      );

      console.log(
        "Number of chunks:",
        chunks.length
      );

      const quizResults = [];

      for (
        const chunk of chunks
      ) {

        const response =
          await groq.chat.completions.create({

            model:
              "openai/gpt-oss-120b",

            messages: [

              {

                role:
                  "user",

                content: `

You are an educational quiz generator.

Generate 10 high-quality multiple-choice questions (MCQs) based ONLY on the information provided in the text below.

Rules:

1. Use only information explicitly present in the text.
2. Do not add outside knowledge or make assumptions.
3. Each question must be directly answerable from the given text.
4. Each question must have exactly 4 options: A, B, C, and D.
5. Only one option must be correct.
6. The correct answer must be directly supported by the text.
7. Avoid duplicate or very similar questions.
8. Create a mix of conceptual, factual, and understanding-based questions.
9. Keep the questions clear, concise, and suitable for a student.
10. If the text does not contain enough information for 10 meaningful questions, generate only as many questions as can be supported by the text.
11. Do not invent facts to reach the required number of questions.

Use EXACTLY this format:

Q1. Question

A) Option A
B) Option B
C) Option C
D) Option D

Answer: B

Explanation: Brief explanation based only on the text.

Q2. Question

A) Option A
B) Option B
C) Option C
D) Option D

Answer: D

Explanation: Brief explanation based only on the text.

Continue this format.

Text:

${chunk}

`
              }

            ]
          });

        quizResults.push(
          response
            .choices[0]
            .message
            .content
        );
      }

      const quiz =
        quizResults.join(
          "\n\n"
        );

      await Quiz.create({

        filename:
          req.file.originalname,

        quizText:
          quiz,

        user:
          req.session.userId
      });

      res.render(
        "quiz",
        {
          quiz
        }
      );

    } catch (error) {

      console.error(error);

      res.send(
        "Error generating quiz"
      );
    }
  }
);

// ======================================================
// DOUBT PAGE
// ======================================================

app.get(
  "/doubt",
  isLoggedIn,
  async (req, res) => {

    try {

      const doubt =
        await Doubt.findOne({
          userId:
            req.session.userId
        })
        .sort({
          createdAt: -1
        });

      res.render(
        "doubt",
        {
          answer: null,
          question: ""
        }
      );

    } catch (error) {

      console.error(error);

      res.render(
        "doubt",
        {
          answer: null,
          question: ""
        }
      );
    }
  }
);

// ======================================================
// DOUBT POST
// ======================================================

app.post(
  "/doubt",
  isLoggedIn,

  async (req, res) => {

    try {

      const question =
        req.body.question;

      if (
        !question ||
        !question.trim()
      ) {

        return res.render(
          "doubt",
          {
            answer:
              "Please enter a question.",
            question:
              question || ""
          }
        );
      }

      const prompt = `

You are an AI tutor helping a student understand concepts clearly.

Explain the following question in a structured and easy way.

Use this format:

## Concept
Explain the concept clearly in simple words.

## Key Points
- Important idea 1
- Important idea 2
- Important idea 3

## Example
Give a simple example if possible.

## Summary
Short 1–2 line recap.

Question:
${question}

`;

      const response =
        await groq.chat.completions.create({

          messages: [

            {
              role:
                "user",

              content:
                prompt
            }

          ],

          model:
            "openai/gpt-oss-120b"
        });

      const answer =
        response
          .choices[0]
          .message
          .content;

      await Doubt.create({

        question:
          question,

        answer:
          answer,

        userId:
          req.session.userId
      });

      res.render(
        "doubt",
        {
          answer,
          question
        }
      );

    } catch (error) {

      console.error(error);

      res.send(
        "Error generating answer"
      );
    }
  }
);

// ======================================================
// NOTES
// ======================================================

app.get(
  "/notes",
  isLoggedIn,
  async (req, res) => {

    try {

      const summaries =
        await Summary.find({
          user:
            req.session.userId
        })
        .sort({
          createdAt: -1
        });

      const quizzes =
        await Quiz.find({
          user:
            req.session.userId
        })
        .sort({
          createdAt: -1
        });

      const doubts =
        await Doubt.find({
          userId:
            req.session.userId
        })
        .sort({
          createdAt: -1
        });

      res.render(
        "notes",
        {
          summaries,
          quizzes,
          doubts
        }
      );

    } catch (error) {

      console.error(error);

      res.send(
        "Error loading notes"
      );
    }
  }
);

// ======================================================
// FLASHCARDS PAGE
// ======================================================

app.get(
  "/flashcards",
  isLoggedIn,
  async (req, res) => {

    try {

      const cards =
        await Flashcard.find({
          user:
            req.session.userId
        })
        .sort({
          createdAt: -1
        });

      res.render(
        "flashcards",
        {
          cards
        }
      );

    } catch (error) {

      console.log(error);

      res.send(
        "Error loading flashcards"
      );
    }
  }
);

// ======================================================
// FLASHCARDS POST
// ======================================================

app.post(
  "/flashcards",
  isLoggedIn,

  async (req, res) => {

    const text =
      req.body.text;

    try {

      const completion =
        await groq.chat.completions.create({

          model:
            "openai/gpt-oss-120b",

          messages: [

            {

              role:
                "user",

              content: `

Generate 5 flashcards from the following notes.

Format:

Question: ...
Answer: ...

Notes:

${text}

`
            }

          ]
        });

      const output =
        completion
          .choices[0]
          .message
          .content;

      const flashcards = [];

      const parts =
        output.split(
          "Question:"
        );

      parts
        .slice(1)
        .forEach(
          (part) => {

            const q =
              part
                .split(
                  "Answer:"
                )[0]
                .trim();

            const a =
              part
                .split(
                  "Answer:"
                )[1]
                .trim();

            flashcards.push({

              question:
                q,

              answer:
                a
            });
          }
        );

      for (
        const card
        of flashcards
      ) {

        await Flashcard.create({

          question:
            card.question,

          answer:
            card.answer,

          user:
            req.session.userId
        });
      }

      res.redirect(
        "/flashcards"
      );

    } catch (error) {

      console.log(error);

      res.send(
        "Error generating flashcards"
      );
    }
  }
);

// ======================================================
// CHAT PAGE
// ======================================================

app.get(
  "/chat",
  isLoggedIn,
  async (req, res) => {

    try {

      const chats =
        await chat.find({
          user:
            req.session.userId
        })
        .sort({
          createdAt: -1
        });

      res.render(
        "chat",
        {
          chats
        }
      );

    } catch (error) {

      console.error(error);

      res.send(
        "Error loading chat"
      );
    }
  }
);

// ======================================================
// RAG CHAT
// ======================================================

app.post(
  "/chat",
  isLoggedIn,

  async (req, res) => {

    try {

      const userMessage =
        req.body.message;

      // =================================================
      // 1. CHECK QUESTION
      // =================================================

      if (
        !userMessage ||
        !userMessage.trim()
      ) {

        return res.status(400).json({

          error:
            "Message is required"
        });
      }

      // =================================================
      // 2. RETRIEVE RELEVANT CHUNKS
      // =================================================

      console.log(
        "Creating query embedding..."
      );

      const results =
        await retrieveRelevantChunks(

          userMessage,

          req.session.userId,

          5
        );

      console.log(
        "Retrieved chunks:",
        results.length
      );

      // =================================================
      // 3. NO CONTEXT FOUND
      // =================================================

      if (
        !results ||
        results.length === 0
      ) {

        return res.json({

          reply:
            "I couldn't find this information in the uploaded document."
        });
      }

      // =================================================
      // 4. BUILD CONTEXT
      // =================================================

      const context =
        buildContext(
          results
        );

      // =================================================
      // 5. GET CHAT HISTORY
      // =================================================

      const previousChats =
        await chat.find({

          user:
            req.session.userId

        })
        .sort({
          createdAt: 1
        })
        .limit(10);

      // =================================================
      // 6. SYSTEM PROMPT
      // =================================================

      const systemPrompt = `

You are COGNORA AI,
an AI study assistant.

Your job is to answer the student's
question using ONLY the retrieved
information from the uploaded document.

========================================
RETRIEVED DOCUMENT CONTEXT
========================================

${context}

========================================
STRICT RULES
========================================

1. Use ONLY the document context above.

2. Do NOT use outside knowledge.

3. Do NOT make up information.

4. If the answer is not present
   in the retrieved context, say:

"I couldn't find this information in the uploaded document."

5. Explain concepts in simple,
   student-friendly language.

6. Use headings and bullet points
   when useful.

7. Keep the answer clear and concise.

8. If the question asks about a concept,
   explain it based only on the document.

`;

      // =================================================
      // 7. CREATE MESSAGES
      // =================================================

      const messages = [

        {
          role:
            "system",

          content:
            systemPrompt
        }

      ];

      // =================================================
      // 8. ADD PREVIOUS CHAT HISTORY
      // =================================================

      previousChats.forEach(
        (previousChat) => {

          messages.push({

            role:
              "user",

            content:
              previousChat.message
          });

          messages.push({

            role:
              "assistant",

            content:
              previousChat.response
          });
        }
      );

      // =================================================
      // 9. CURRENT QUESTION
      // =================================================

      messages.push({

        role:
          "user",

        content:
          userMessage
      });

      // =================================================
      // 10. GROQ GENERATION
      // =================================================

      console.log(
        "Generating final answer..."
      );

      const completion =
        await groq.chat.completions.create({

          model:
            "openai/gpt-oss-120b",

          messages:
            messages,

          temperature:
            0.2
        });

      // =================================================
      // 11. GET ANSWER
      // =================================================

      const reply =
        completion
          .choices[0]
          .message
          .content;

      // =================================================
      // 12. SAVE USER MESSAGE
      // =================================================

      await chat.create({

        message:
          userMessage,

        response:
          reply,

        user:
          req.session.userId
      });

      // =================================================
      // 13. RESPONSE
      // =================================================

      res.json({

        reply:
          reply,

        sources:
          results.map(
            (result) => ({

              filename:
                result.filename,

              score:
                result.score
            })
          )
      });

    } catch (error) {

      console.error(
        "RAG Chat Error:",
        error
      );

      res.status(500).json({

        error:
          "Something went wrong while processing your question."
      });
    }
  }
);

// ======================================================
// UPLOAD DOCUMENT + CREATE RAG EMBEDDINGS
// ======================================================

app.post(
  "/upload-document",

  isLoggedIn,

  upload.single("file"),

  async (req, res) => {

    try {

      // =================================================
      // 1. CHECK FILE
      // =================================================

      if (!req.file) {

        return res.status(400).json({

          error:
            "No file uploaded"
        });
      }

      // =================================================
      // 2. EXTRACT TEXT
      // =================================================

      let extractedText = "";

      // -------------------------------------------------
      // PDF
      // -------------------------------------------------

      if (
        req.file.mimetype ===
        "application/pdf"
      ) {

        console.log(
          "PDF detected"
        );

        const data =
          await pdfParse(
            req.file.buffer
          );

        extractedText =
          data.text;
      }

      // -------------------------------------------------
      // IMAGE
      // -------------------------------------------------

      else if (
        req.file.mimetype.startsWith(
          "image/"
        )
      ) {

        console.log(
          "Image detected"
        );

        const processedImage =
          await sharp(
            req.file.buffer
          )

          .resize({

            width:
              2000,

            withoutEnlargement:
              false
          })

          .grayscale()

          .normalize()

          .sharpen()

          .threshold(
            160
          )

          .png()

          .toBuffer();

        const result =
          await Tesseract.recognize(

            processedImage,

            "eng"
          );

        extractedText =
          result.data.text;

        console.log(
          "OCR text extracted"
        );
      }

      // -------------------------------------------------
      // UNSUPPORTED
      // -------------------------------------------------

      else {

        return res.status(400).json({

          error:
            "Only PDF and image files are supported"
        });
      }

      // =================================================
      // 3. CLEAN TEXT
      // =================================================

      extractedText =
        extractedText.trim();

      if (
        !extractedText
      ) {

        return res.status(400).json({

          error:
            "Could not extract text from document"
        });
      }

      console.log(
        "Extracted characters:",
        extractedText.length
      );

      // =================================================
      // 4. CREATE DOCUMENT ID
      // =================================================

      const documentId =

        Date.now().toString() +
        "-" +
        Math.random()
          .toString(36)
          .substring(2, 8);

      console.log(
        "Document ID:",
        documentId
      );

      // =================================================
      // 5. CHUNK + EMBEDDING + MONGODB
      // =================================================

      const numberOfChunks =
        await processAndStoreDocument({

          text:
            extractedText,

          filename:
            req.file.originalname,

          userId:
            req.session.userId,

          documentId:
            documentId
        });

      // =================================================
      // 6. SESSION
      // =================================================

      req.session.documentText =
        extractedText;

      req.session.documentId =
        documentId;

      // =================================================
      // 7. RESPONSE
      // =================================================

      res.json({

        success:
          true,

        message:
          "Document uploaded and indexed successfully",

        filename:
          req.file.originalname,

        documentId:
          documentId,

        chunks:
          numberOfChunks
      });

    } catch (error) {

      console.error(
        "RAG Upload Error:",
        error
      );

      res.status(500).json({

        success:
          false,

        error:
          error.message ||
          "Error processing document"
      });
    }
  }
);

// ======================================================
// LOGOUT
// ======================================================

app.get(
  "/logout",
  (req, res) => {

    req.session.destroy(
      () => {

        res.redirect("/");
      }
    );
  }
);

// ======================================================
// START SERVER
// ======================================================

app.listen(
  port,
  () => {

    console.log(
      `Cognora server running at http://localhost:${port}`
    );
  }
);
