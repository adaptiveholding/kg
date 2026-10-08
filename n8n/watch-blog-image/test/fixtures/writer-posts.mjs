// Hand-written writer outputs in the shape the Watch Centro "Writer (LLM)" node returns.
// Fed through the real "Render WP blocks" code (render-wp-blocks.js) by generate.mjs.

export const WRITER_POSTS = {
  steel: {
    data_window: 'October 6 to October 7, 2026',
    post: {
      headline_topic: 'Steel sports models lead',
      title: 'Watch Market Report: Submariner and Royal Oak Lead Steel Demand',
      slug: 'watch-market-report-24h-2026-10-07-steel-sports-demand',
      excerpt: 'Steel sports models drew most of the attention from traders this period.',
      seo_title: 'Watch Market Report: Steel Sports Models Lead',
      meta_description: 'Our watch market report for the day: the Submariner Date and AP Royal Oak led steel demand while traders compared asking prices.',
      focus_keyphrase: 'steel sports watch demand',
      summary: 'Traders spent most of the day on steel sports models. The Rolex Submariner Date 126610LN was the most discussed reference, and the AP Royal Oak came up in several posts about asking prices.',
      takeaway: 'Steel sports watches dominated. Buyers & sellers stayed close on Submariner pricing.',
      glance: [
        { label: 'Activity', value: 'Busy' },
        { label: 'Most mentioned', value: 'Submariner Date' },
        { label: 'Mood', value: 'Steady' },
      ],
      sections: [
        {
          heading: 'The Submariner Date holds the spotlight',
          paragraphs: [
            'Several posts compared asking prices for the Submariner Date 126610LN with listings on Chrono24. Traders described the gap as narrow.',
            'A couple of posts said full sets with box & papers sold faster than watch-only examples.',
          ],
        },
        {
          heading: 'AP Royal Oak and the Black Bay 58',
          paragraphs: [
            'The AP Royal Oak drew steady interest. Traders said the "Jumbo" remains hard to find.',
            'The Tudor Black Bay 58 was described as the usual pick for buyers with a budget under $4,000.',
          ],
        },
        {
          heading: 'Trust and safety',
          paragraphs: [
            'Traders flagged a pattern of cheap replica offers sent by direct message.',
            'Tip: meet in a public place or use an escrow service for high-value deals.',
          ],
        },
      ],
      table: {
        caption: 'Most mentioned models in this window (rank > 4 omitted)',
        headers: ['Rank', 'Model', 'Brand', 'Mentions'],
        rows: [
          ['1', 'Submariner Date', 'Rolex', 'Leading'],
          ['2', 'Royal Oak', 'Audemars Piguet', 'Strong'],
          ['3', 'Black Bay 58', 'Tudor', 'Steady'],
          ['4', 'Speedmaster Professional', 'Omega', 'Steady'],
        ],
      },
      closing: 'That is the picture for the day. The next report follows tomorrow.',
    },
  },

  dress: {
    data_window: 'September 30 to October 7, 2026',
    post: {
      headline_topic: 'Dress watches gain ground',
      title: 'Weekly Watch Market Report: Dress Watches Gain Ground',
      slug: 'watch-market-report-7d-2026-10-07-dress-watches',
      excerpt: 'Dress watches from JLC and A. Lange & Söhne took a larger share of the conversation this week.',
      seo_title: 'Weekly Watch Market Report: Dress Watches',
      meta_description: 'This weekly watch market report covers the dress watch upswing, from the JLC Reverso to the Lange 1, and how traders talked about value.',
      focus_keyphrase: 'dress watch market',
      summary: 'Dress watches took a larger share of the conversation this week. The JLC Reverso Tribute and the Lange 1 from A. Lange & Söhne led the discussion.',
      takeaway: 'Interest moved toward smaller, thinner dress pieces. The Patek Philippe Nautilus 5711/1A was mentioned less than the week before.',
      glance: [
        { label: 'Activity', value: 'Moderate' },
        { label: 'Most mentioned', value: 'Reverso Tribute' },
        { label: 'Mood', value: 'Curious' },
      ],
      sections: [
        {
          heading: 'Reverso and Lange 1 lead',
          paragraphs: [
            'Traders compared the JLC Reverso Tribute with the Lange 1 in several posts. Most of the discussion was about case size and wearability.',
            'One post asked whether the Grand Seiko "Snowflake" belongs in the same conversation. Replies said the GS Snowflake is a sports-dress hybrid.',
          ],
        },
        {
          heading: 'Nautilus talk cools',
          paragraphs: [
            'The Patek Philippe Nautilus 5711/1A came up in fewer posts than the week before.',
            'A single post mentioned an eBay auction ending without a sale.',
          ],
        },
        {
          heading: 'Trust and safety',
          paragraphs: ['Tip: ask for a timestamped photo before paying a deposit.'],
        },
      ],
      table: {
        caption: 'Most mentioned models this week',
        headers: ['Rank', 'Model', 'Brand', 'Mentions'],
        rows: [
          ['1', 'Reverso Tribute', 'Jaeger-LeCoultre', 'Leading'],
          ['2', 'Lange 1', 'A. Lange & Söhne', 'Strong'],
          ['3', 'Nautilus 5711/1A', 'Patek Philippe', 'Lower'],
        ],
      },
      closing: 'The next weekly report follows in seven days.',
    },
  },

  quiet: {
    data_window: 'October 7 to October 8, 2026',
    post: {
      headline_topic: 'Quiet day, safe deals',
      title: 'Watch Market Report: Quiet Day as Traders Focus on Safe Deals',
      slug: 'watch-market-report-24h-2026-10-08-quiet-safe-deals',
      excerpt: 'A quiet day in which traders mostly talked about shipping and payment safety.',
      seo_title: 'Watch Market Report: A Quiet Day',
      meta_description: 'A quiet watch market report day: traders talked about insured shipping, payment methods and how to approach cheap offers safely.',
      focus_keyphrase: 'safe watch deals',
      summary: 'It was a quiet day. Traders mostly talked about insured shipping and how to approach deals that look too cheap.',
      takeaway: 'Few models were discussed. Shipping and payment safety took most of the attention.',
      glance: [
        { label: 'Activity', value: 'Quiet' },
        { label: 'Most mentioned', value: 'Shipping' },
        { label: 'Mood', value: 'Cautious' },
      ],
      sections: [
        {
          heading: 'Shipping questions',
          paragraphs: [
            'Several posts asked how to insure a parcel for international delivery. Traders said they prefer tracked services with a signature on delivery.',
          ],
        },
        {
          heading: 'Payment safety',
          paragraphs: [
            'A couple of posts warned that cheap prices paired with pressure to pay quickly are a common pattern.',
            'Tip: pay with a method that offers buyer protection, and never send a deposit before you see the watch on a video call.',
          ],
        },
      ],
      table: { caption: '', headers: [], rows: [] },
      closing: 'The next report follows tomorrow.',
    },
  },
};
