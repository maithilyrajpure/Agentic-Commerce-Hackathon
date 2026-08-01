import dotenv from 'dotenv';

dotenv.config();

export const config = {
  port: process.env.PORT || 3100,
  linqApiToken: process.env.LINQ_API_TOKEN || '',
  linqPhoneNumber: process.env.LINQ_PHONE_NUMBER || '',
  pravaApiKey: process.env.PRAVA_API_KEY || '',
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  browserbaseApiKey: process.env.BROWSERBASE_API_KEY || '',
};
