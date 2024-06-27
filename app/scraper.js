const { chromium } = require('playwright')
const fs = require('fs')
const cheerio = require('cheerio')
const { format } = require('path')

const endpoint = 'https://www.houseofyes.org/'
let gigzArr = []

// Retry function to handle retries with delay
const retry = async (fn, retries, delay) => {
  try {
    return await fn()
  } catch (error) {
    if (retries > 1) {
      await new Promise(resolve => setTimeout(resolve, delay))
      return retry(fn, retries - 1, delay)
    } else {
      throw error
    }
  }
}

;(async () => {
  const browser = await chromium.launch({ headless: false })
  const context = await browser.newContext()
  const page = await context.newPage()

  await page.goto(endpoint, { waitUntil: 'domcontentloaded' })

  await page.click(
    'a.sqs-block-button-element--medium.sqs-button-element--primary.sqs-block-button-element'
  )

  await page.waitForSelector('td.cal-ticket a')

  const eventLinks = await dynamicScrollAndCollectLinks(page, 'td.cal-ticket a')
  console.log(`Collected ${eventLinks.length} event links`)

  for (const link of eventLinks) {
    const gigDetails = await scrapeEventDetails(context, link)
    if (gigDetails) gigzArr.push(gigDetails)
  }

  console.log(`Scraped ${gigzArr.length} event details`)
  await browser.close()

  if (gigzArr.length) {
    fs.writeFileSync('events.json', JSON.stringify(gigzArr, null, 2), 'utf-8')
    console.log('Data saved to events.json')
  } else {
    console.log('No data to save.')
  }
})()

const dynamicScrollAndCollectLinks = async (page, selector) => {
  let links = new Set()
  try {
    let previousSize = 0
    let newSize = 0
    do {
      previousSize = links.size
      const newLinks = await page.$$eval(selector, elements =>
        elements.map(el => el.href)
      )
      newLinks.forEach(link => links.add(link))
      newSize = links.size
      if (newSize > previousSize) {
        await page.evaluate('window.scrollTo(0, document.body.scrollHeight)')
        await page.waitForTimeout(2000)
      }
    } while (newSize > previousSize)
  } catch (error) {
    console.error('Error during dynamic scroll and link collection: ', error)
  }
  return Array.from(links)
}

const scrapeEventDetails = async (context, link) => {
  let eventPage
  try {
    // Retry mechanism to handle opening a new page
    eventPage = await retry(
      async () => {
        return await context.newPage()
      },
      3,
      1000
    ) // 3 retries with 1-second delay

    await eventPage.goto(link, { waitUntil: 'domcontentloaded' })

    const platform = link.includes('eventbrite')
      ? 'Eventbrite'
      : link.includes('shotgun')
      ? 'Shotgun'
      : 'unknown'

    let title, date, genre, location, time, price, image, excerptHtml, excerpt

    // Extracting title and date/time
    if (platform === 'Eventbrite' || platform === 'Shotgun') {
      title = await eventPage.evaluate(() => {
        const titleElement = document.querySelector(
          '.event-title.css-0, h1.event-title, .ng-binding.pointer, h1.css-901oao'
        )
        return titleElement
          ? titleElement.textContent.trim()
          : 'Title Not Found'
      })

      if (platform === 'Eventbrite') {
        genre = 'party'
        location = 'House of Yes'
        const dateTimeText = await eventPage.$eval('span.date-info__full-datetime', el =>
            el.textContent.trim()
          );
          const [datePart, timePart] = dateTimeText.split('·').map(part => part.trim());
    
          date = formatDateStringForMongoDB(datePart);
          time = timePart || 'Time Not Found';
        price = await eventPage
          .$eval(
            '.conversion-bar__panel-info',
            el => el.textContent.trim() || 'private event'
          )
          .catch(() => '')
        image = await eventPage
          .$eval(
            'picture[data-testid="hero-image"] img',
            img => img.getAttribute('src') || ''
          )
          .catch(() => '')
        excerptHtml = await eventPage
          .$eval(
            '.event-description__content--expanded',
            el => el.innerHTML || ''
          )
          .catch(() => '')
      } else if (platform === 'Shotgun') {
        genre = 'party'
        location = 'House of Yes'
        const dateTimeText = await eventPage.$eval(
            'div.css-901oao.r-d8nonl.r-c321bz.r-ubezar.r-13uqrnb.r-majxgm.r-rjixqe',
            el => el.textContent.trim()
          );
    
          const dateParts = dateTimeText.split(' ').filter(part => part.trim().length > 0);
          const day = dateParts[1];
          const month = dateParts[2];
          const formattedDate = formatDateStringForMongoDB(`${day} ${month}`);
    
          date = formattedDate;
          time = await eventPage.$eval(
            'span.css-901oao.css-16my406.r-jwli3a.r-c321bz.r-ubezar.r-13uqrnb.r-majxgm.r-rjixqe',
            el => el.textContent.trim()
          )
          price = await eventPage.evaluate(() => {
            const priceElement = document.querySelector(
              "a[class='css-4rbku5 css-18t94o4 css-1dbjc4n r-1awozwy r-14lw9ot r-z2wwpe r-1yadl64 r-1loqt21 r-hvic4v r-18u37iz r-irg0bu r-16l9doz r-1777fci r-peo1c r-1gwld19 r-6dt33c r-1mi0q7o r-b5h31w r-1ah4tor r-m611by r-1otgn73 r-iyfy8q'] div[class='css-901oao r-4tuo4v r-c321bz r-1b43r93 r-13uqrnb r-b88u0q r-1ikidpy r-rjixqe r-q4m81j r-tsynxw']"
            )
            return priceElement
              ? priceElement.textContent.trim()
              : '🕘 Join waiting list'
          })

        image = await eventPage.evaluate(() => {
          const imageElement = document.evaluate(
            "//div[@class='css-1dbjc4n r-1awozwy r-z2wwpe r-18tdg42 r-hqy403 r-1777fci r-1udh08x r-bnwqim']//img",
            document,
            null,
            XPathResult.FIRST_ORDERED_NODE_TYPE,
            null
          ).singleNodeValue
          return imageElement ? imageElement.src : ''
        })

        excerptHtml = await eventPage.evaluate(() => {
          const descriptionElement = document.querySelector(
            'div.event-description-html'
          )
          return descriptionElement ? descriptionElement.innerHTML : ''
        })
      }
    }

    excerpt = processExcerpt(excerptHtml, link)

    await eventPage.close()

    return {
      title,
      date,
      genre,
      location,
      time,
      price: price || 'private event',
      image,
      excerpt,
      isFeatured: false,
      rating: 0,
      expiresAt: calculateExpiresAt(date)
    }
  } catch (error) {
    if (eventPage) {
      // Ensure the page is closed if an error occurs
      await eventPage.close()
    }
    console.error(`Error scraping details from ${link}: `, error)
    return null
  }
}

const processExcerpt = (html, link) => {
  if (!html) {
    return ''
  }

  const $ = cheerio.load(html)
  let formattedExcerpt = ''

  $('p').each((i, el) => {
    let paragraph = $.html(el);

    // Find all occurrences of sequences of "······"
    paragraph = paragraph.replace(/······+/g, (match) => {
      if (match.length > 26) {
        return '··························';
      }
      return match;
    });

    formattedExcerpt += paragraph;
  });

  if (link) {
    formattedExcerpt += `<br><br><ul><li><a href='${link}'>BUY TICKETS</a></li></ul>`
  }

  return formattedExcerpt
}

// Function to format date string for MongoDB
const formatDateStringForMongoDB = (dateString) => {
    const currentYear = new Date().getFullYear();
    const date = new Date(`${dateString} ${currentYear}`);
  
    // Convert date to ISO string
    let isoString = date.toISOString();
  
    let datePart = isoString.split('T')[0]; // Separates date from time
    let timePart = '00:00:00.000';
    let timezoneOffset = '+00:00'; // Adjust if you need a different timezone
  
    return `${datePart}T${timePart}${timezoneOffset}`;
  };

const calculateExpiresAt = eventDate => {
  const date = new Date(eventDate)

  if (isNaN(date)) {
    return ''
  }

  date.setUTCDate(date.getUTCDate() + 1)
  date.setUTCHours(2, 0, 0, 0)

  return date.toISOString()
}
