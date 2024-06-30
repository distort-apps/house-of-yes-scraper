const { chromium } = require('playwright');
const fs = require('fs');
const cheerio = require('cheerio');

const endpoint = 'https://www.houseofyes.org/';
let events = [];

// Retry function to handle retries with delay
const retry = async (fn, retries, delay) => {
  try {
    return await fn();
  } catch (error) {
    if (retries > 1) {
      await new Promise(resolve => setTimeout(resolve, delay));
      return retry(fn, retries - 1, delay);
    } else {
      throw error;
    }
  }
};

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(endpoint, { waitUntil: 'domcontentloaded' });

  console.log('Clicking "See Full Calendar" button...');
  await page.click('a.sqs-block-button-element--medium.sqs-button-element--primary.sqs-block-button-element');

  console.log('Waiting for iframe to load...');
  await handleIframe(page, async (iframe) => {
    console.log('Handling iframe...');
    
    console.log('Press "View More" button now...');
    await new Promise(resolve => setTimeout(resolve, 10000)); // Wait for 10 seconds
    
    const eventLinks = await collectEventTitlesAndLinks(iframe, 'a.a-pressable-img');
    console.log(`Collected ${eventLinks.length} event links`);

    for (const event of eventLinks) {
      console.log(`Scraping details for event: ${event.title}`);
      const eventDetails = await scrapeEventDetails(context, event.link);
      events.push({ ...event, ...eventDetails });
    }
  });

  await browser.close();

  if (events.length) {
    fs.writeFileSync('events.json', JSON.stringify(events, null, 2), 'utf-8');
    console.log('Events saved to events.json');
  } else {
    console.log('No data to save.');
  }
})();

const handleIframe = async (page, callback) => {
  try {
    const iframeElement = await page.waitForSelector('iframe');
    console.log('Iframe element found.');
    const iframe = await iframeElement.contentFrame();
    if (!iframe) {
      throw new Error('Iframe not found');
    }
    await callback(iframe);
  } catch (error) {
    console.error('Error handling iframe: ', error);
  }
};

const collectEventTitlesAndLinks = async (iframe, linkSelector) => {
  let events = [];
  try {
    const elements = await iframe.$$(linkSelector);
    console.log(`Found ${elements.length} elements matching the selector`);

    for (const element of elements) {
      const titleElement = await element.$('div[dir="auto"].css-901oao.css-cens5h.r-11zsu6o.r-c321bz.r-1i10wst.r-13uqrnb.r-b88u0q.r-hbpseb');
      if (titleElement) {
        const title = await titleElement.textContent();
        const link = await element.getAttribute('href');
        console.log(`Collected event - Title: ${title.trim()}, Link: ${link}`);
        events.push({ title: title.trim(), link });
      } else {
        console.log('No title found for an element');
      }
    }
  } catch (error) {
    console.error('Error collecting event titles and links: ', error);
  }
  return events;
};

const scrapeEventDetails = async (context, link) => {
  const eventPage = await context.newPage();
  await eventPage.goto(link, { waitUntil: 'domcontentloaded' });

  const details = {};

  try {
    // Extracting title, date, and time
    details.title = await eventPage.evaluate(() => {
      const titleElement = document.querySelector(
        '.event-title.css-0, h1.event-title, .ng-binding.pointer, h1.css-901oao'
      );
      return titleElement
        ? titleElement.textContent.trim()
        : 'Title Not Found';
    }).catch(() => 'N/A');

    const dateString = await eventPage.$eval('div[dir="auto"].css-901oao.r-d8nonl.r-c321bz.r-ubezar.r-13uqrnb.r-majxgm.r-rjixqe', el => el.textContent.trim()).catch(() => 'N/A');
    const formattedDate = formatDateStringForMongoDB(dateString);
    details.date = formattedDate.start;

    details.time = await eventPage.$eval('div[dir="auto"].css-901oao.r-d8nonl.r-c321bz.r-ubezar.r-13uqrnb.r-majxgm.r-rjixqe span.css-901oao.css-16my406.r-jwli3a.r-c321bz.r-ubezar.r-13uqrnb.r-majxgm.r-rjixqe', el => el.textContent.trim()).catch(() => 'N/A');
    details.location = await eventPage.$eval('div.css-901oao.r-1uaz6oj.r-qklmqi.r-13awgt0.r-1777fci.r-11wrixw.r-1l7z4oj.r-95jzfe a', el => el.textContent.trim()).catch(() => 'House of Yes');
    details.genre = 'party';

    details.price = await eventPage.evaluate(() => {
      const priceElement = document.querySelector(
        "a[class='css-4rbku5 css-18t94o4 css-1dbjc4n r-1awozwy r-14lw9ot r-z2wwpe r-1yadl64 r-1loqt21 r-hvic4v r-18u37iz r-irg0bu r-16l9doz r-1777fci r-peo1c r-1gwld19 r-6dt33c r-1mi0q7o r-b5h31w r-1ah4tor r-m611by r-1otgn73 r-iyfy8q'] div[class='css-901oao r-4tuo4v r-c321bz r-1b43r93 r-13uqrnb r-b88u0q r-1ikidpy r-rjixqe r-q4m81j r-tsynxw']"
      );
      return priceElement
        ? priceElement.textContent.trim()
        : '🕘 Join waiting list';
    }).catch(() => 'private event');

    // Attempt to get high-quality image URL
    details.image = await eventPage.evaluate(() => {
      let imageElement = document.querySelector('img[alt]');
      if (imageElement && imageElement.src) {
        const baseUrl = 'https://res.cloudinary.com/shotgun/image/upload/';
        const transformationParams = 'ar_16:9,c_limit,f_auto,fl_lossy,q_auto,w_854/';
        const imagePath = imageElement.src.split('/').slice(-3).join('/'); // Adjust this based on the actual URL structure
        return baseUrl + transformationParams + imagePath;
      }
      return 'N/A';
    }).catch(() => 'N/A');

    const excerptHtml = await eventPage.$eval('div.event-description-html', el => el.innerHTML.trim()).catch(() => 'N/A');
    details.excerpt = processExcerpt(excerptHtml, link);

    details.isFeatured = false;
    details.rating = 0;
    details.expiresAt = calculateExpiresAt(details.date);

  } catch (error) {
    console.error(`Error scraping details for ${link}: `, error);
  }

  await eventPage.close();
  return details;
};

const processExcerpt = (html, link) => {
  if (!html) {
    return '';
  }

  const $ = cheerio.load(html);
  let formattedExcerpt = '';

  $('p').each((i, el) => {
    let paragraph = $.html(el);

    paragraph = paragraph.replace(/······+/g, (match) => {
      if (match.length > 26) {
        return '··························';
      }
      return match;
    });

    formattedExcerpt += paragraph;
  });

  if (link) {
    formattedExcerpt += `<br><br><ul><li><a href='${link}'>BUY TICKETS</a></li></ul>`;
  }

  return formattedExcerpt;
};

// Function to format date string for MongoDB
const formatDateStringForMongoDB = (dateString) => {
  const datePattern = /(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (\d{1,2}) (\w{3})/;
  const timePattern = /From (\d{1,2}:\d{2} [APM]{2}) To (\d{1,2}:\d{2} [APM]{2})/;

  const dateMatch = dateString.match(datePattern);
  const timeMatch = dateString.match(timePattern);

  if (!dateMatch || !timeMatch) {
    return 'Invalid Date Format';
  }

  const day = dateMatch[2];
  const month = dateMatch[3];
  const currentYear = new Date().getFullYear();

  const startTime = timeMatch[1];
  const endTime = timeMatch[2];

  const startDateTime = new Date(`${month} ${day}, ${currentYear} ${startTime}`);
  const endDateTime = new Date(`${month} ${day}, ${currentYear} ${endTime}`);

  if (endDateTime < startDateTime) {
    endDateTime.setDate(endDateTime.getDate() + 1);
  }

  // Format to ISO 8601 string (YYYY-MM-DDTHH:MM:SS.SSSZ)
  const isoStartDateTime = startDateTime.toISOString();
  const isoEndDateTime = endDateTime.toISOString();

  // Extract date part only (YYYY-MM-DD)
  const isoStartDateOnly = isoStartDateTime.split('T')[0];
  const isoEndDateOnly = isoEndDateTime.split('T')[0];

  return {
    start: `${isoStartDateOnly}T00:00:00.000+00:00`,
    end: `${isoEndDateOnly}T00:00:00.000+00:00`
  };
};

const calculateExpiresAt = eventDate => {
  const date = new Date(eventDate);

  if (isNaN(date)) {
    return '';
  }

  date.setUTCDate(date.getUTCDate() + 1);
  date.setUTCHours(2, 0, 0, 0);

  return date.toISOString();
};
