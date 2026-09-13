const mongoose = require("mongoose");

const documentChunkSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    documentId: {
      type: String,
      required: true,
    },

    filename: {
      type: String,
      required: true,
    },

    text: {
      type: String,
      required: true,
    },

    embedding: {
      type: [Number],
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("DocumentChunk", documentChunkSchema);
