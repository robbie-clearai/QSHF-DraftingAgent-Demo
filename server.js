const express = require('express');
const multer = require('multer');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const GEMINI_API_KEY = 'AIzaSyAbhpc-iiH7f_GbxIWJLrfhnPLvQAhl9rs';
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${GEMINI_API_KEY}`;
const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(__dirname, 'uploads');

// Ensure directories exist
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});
const upload = multer({ storage, fileFilter: (req, file, cb) => {
  if (file.mimetype === 'application/pdf') cb(null, true);
  else cb(new Error('Only PDF files are accepted'));
}});

app.use(express.static(path.join(__dirname, 'public')));

const SCORING_CATEGORIES = [
  { category: "Joist Direction (two-storey only)", weight: 15, impact: "Major" },
  { category: "External Dimensions", weight: 15, impact: "Major" },
  { category: "Roof Shape", weight: 10, impact: "Significant" },
  { category: "Roof Pitch (Angle)", weight: 10, impact: "Significant" },
  { category: "Roof Material", weight: 10, impact: "Significant" },
  { category: "Wind Speed Class", weight: 5, impact: "Moderate" },
  { category: "Interior Dimensions", weight: 1, impact: "Minor" },
  { category: "Opening Sizes and Positions", weight: 1, impact: "Minor" },
  { category: "Building Mirroring", weight: 0.5, impact: "Minor" },
  { category: "Eave Width / Cutback", weight: 0.5, impact: "Minor" },
  { category: "Heavy Set Items (per item)", weight: 0.2, impact: "Minimal" },
  { category: "Flooring Material", weight: 0.5, impact: "Minor" },
  { category: "A/C Type (ducted vs. units)", weight: 0.3, impact: "Minor" },
  { category: "NDIS Grab Rails", weight: 0.2, impact: "Minimal" },
  { category: "Wet Area Differences", weight: 0.5, impact: "Minor" }
];

function pdfToBase64(filePath) {
  const buffer = fs.readFileSync(filePath);
  return buffer.toString('base64');
}

async function compareWithGemini(inputPdfPath, existingPdfPath, existingFileName) {
  const inputBase64 = pdfToBase64(inputPdfPath);
  const existingBase64 = pdfToBase64(existingPdfPath);

  const categoriesJson = JSON.stringify(SCORING_CATEGORIES, null, 2);

  const prompt = `You are an expert steel house frame drafter analyzing construction plans.
You will compare two construction plan PDF documents and determine how similar they are.

PDF 1 is the NEW incoming job (first PDF).
PDF 2 is the EXISTING completed job named "${existingFileName}" (second PDF).

Carefully examine the construction plans pages in each PDF and compare them across the following categories.
For each category, determine if there is a difference between the two jobs.

Scoring categories and their weights:
${categoriesJson}

Instructions:
1. Examine both construction plans carefully
2. For each category, determine if there is a difference (true/false)
3. Calculate the match score: start at 100%, subtract the weight for each category where a difference is found. The score MUST be a plain integer between 0 and 100 — never null, never undefined.
4. For each difference found, describe what would need to be changed IN THE EXISTING FILE (PDF 2) to make it match the new job (PDF 1). Write it as an action, e.g. "change roof pitch from 25° to 22°", "update wind speed from N2 to N3", "mirror the building layout". Do not just state that things differ — say what the existing file must be changed TO.

IMPORTANT: You must respond with ONLY valid JSON, no markdown, no explanation outside the JSON.
The "score" field must always be a number (integer). If every category differs, score is 0. Never return null.
Respond in this exact format:
{
  "score": <integer 0-100, never null>,
  "differences": [
    {
      "category": "<category name>",
      "hasDifference": <true|false>,
      "description": "<what to change in the existing file to match the new job, or 'No change required' if same>"
    }
  ],
  "changesummary": "<comma-separated plain English list of changes to make to the existing file to match the new job, e.g. 'change roof pitch from 25° to 22°, update wind speed from N2 to N3, mirror building layout' — leave empty string only if score is 100>"
}`;

  const requestBody = {
    contents: [
      {
        parts: [
          {
            inline_data: {
              mime_type: "application/pdf",
              data: inputBase64
            }
          },
          {
            inline_data: {
              mime_type: "application/pdf",
              data: existingBase64
            }
          },
          {
            text: prompt
          }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: "application/json"
    }
  };

  const response = await axios.post(GEMINI_API_URL, requestBody, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 120000
  });

  const rawText = response.data.candidates[0].content.parts[0].text;

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (e) {
    // Try to extract JSON from response if it has extra text
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      parsed = JSON.parse(jsonMatch[0]);
    } else {
      throw new Error('Could not parse Gemini response as JSON');
    }
  }

  const rawScore = parsed.score;
  const score = (rawScore === null || rawScore === undefined || isNaN(Number(rawScore)))
    ? 0
    : Math.min(100, Math.max(0, Math.round(Number(rawScore))));

  return {
    fileName: existingFileName,
    score,
    changeSummary: parsed.changesummary || '',
    differences: parsed.differences || []
  };
}

app.post('/api/check-copies', upload.single('pdf'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No PDF file uploaded' });
  }

  const uploadedFilePath = req.file.path;
  const uploadedFileName = req.file.originalname;

  try {
    // Get all PDFs from the data directory
    const dataFiles = fs.readdirSync(DATA_DIR).filter(f => f.toLowerCase().endsWith('.pdf'));

    if (dataFiles.length === 0) {
      return res.status(400).json({
        error: 'No existing job files found in the data directory. Please add PDF files to the /data folder.'
      });
    }

    // Compare uploaded file against each existing job
    const comparisonPromises = dataFiles.map(fileName => {
      const existingPath = path.join(DATA_DIR, fileName);
      return compareWithGemini(uploadedFilePath, existingPath, fileName)
        .catch(err => {
          const isGeminiError = err.response?.status >= 400 || err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT';
          const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
          console.error(`[ERROR] Comparing ${fileName}:`, detail);
          return {
            fileName,
            score: 0,
            changeSummary: '',
            differences: [],
            error: true,
            geminiError: isGeminiError
          };
        });
    });

    const results = await Promise.all(comparisonPromises);

    // If ALL comparisons failed due to Gemini API errors, surface a clear API error
    const allGeminiFailed = results.length > 0 && results.every(r => r.geminiError);
    if (allGeminiFailed) {
      fs.unlink(uploadedFilePath, () => {});
      return res.status(502).json({ error: 'gemini_api_unavailable' });
    }

    // Sort by score descending and take top 3
    const sorted = results
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

    // Clean up uploaded file after processing
    fs.unlink(uploadedFilePath, () => {});

    res.json({
      inputFileName: uploadedFileName,
      topMatches: sorted
    });

  } catch (err) {
    // Clean up uploaded file on error
    fs.unlink(uploadedFilePath, () => {});
    console.error('Error during comparison:', err.message);
    res.status(500).json({ error: `Comparison failed: ${err.message}` });
  }
});

app.listen(PORT, () => {
  console.log(`QSHF Copy Check server running at http://localhost:${PORT}`);
  console.log(`Place existing job PDFs in: ${DATA_DIR}`);
});
