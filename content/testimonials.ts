export interface Testimonial {
  id: number
  name: string
  location: string
  rating: number
  text: string
  image: string
}

export const testimonials: Testimonial[] = [
  {
    id: 1,
    name: 'Cathy Levering',
    location: 'Google Review',
    rating: 5,
    text: "These people really take care of you. Personalized service, Great insights and help, and successfully managing through all those little details. Never have I ever felt as confident as I do when my trip has been planned and booked by Shelby and her team. 10/10.",
    image: '/google-logo-round.jpg',
  },
  {
    id: 2,
    name: 'Christy Clarke',
    location: 'Google Review',
    rating: 5,
    text: "Can't say enough good things! Shelby anticipates everything before I have a chance to ask! Very responsive! Great information!",
    image: '/google-logo-round.jpg',
  },
  {
    id: 3,
    name: 'Cathy Stefans',
    location: 'Facebook Review',
    rating: 5,
    text: "What amazing time we had in Carmen la Playa renewing our wedding vows. Shelby and her team took the time to make sure I chose a location that would meet all my wants and needs. They answered all my questions so I was prepared for a fabolous trip. I cant wait to travel again with the guidance of Shelby and her amazing team.",
    image: '/facebook-logo-round.jpg',
  },
  {
    id: 4,
    name: 'Marlene Dejesus',
    location: 'Google Review',
    rating: 5,
    text: "This company and good assistance of Anita I help came with my family will thanks to them. Michele actually it's helped always new trips a last 4 years. I'm very happy with the service we get and I'm sure I will keep using their services. I just came back from Cancun with my family and it was great. I'm planning on Aruba I really do not want to use the other company that I use before but I'm very happy with this one and I recommend to everybody that they use TravelFun.Biz.",
    image: '/google-logo-round.jpg',
  },
  {
    id: 5,
    name: 'Kara Allaire',
    location: 'Google Review',
    rating: 5,
    text: "Scott Walker did an outstanding job in assisting with booking of our group trip along with being there throughout the trip for any questions. I had the most amazing time and could not of had this lifetime experience if it wasn't for him! I'm truly grateful for the guidance and expertise that came from him to make this trip most memorable!",
    image: '/google-logo-round.jpg',
  },
  {
    id: 6,
    name: 'Cathy Stefans',
    location: 'Facebook Review',
    rating: 5,
    text: "TravelFun.Biz delivers the fun for sure! Great planning with the help of Shelby & Leslie! Tricky decisions needed to be made, as 2 female travelers… safety 1st, then fun. They arranged our Europe 2 city adventure, Rome & London. Tons of experience and 1st hand knowledge to make it easier to navigate once I arrived. Everything from transportation, to hotels, tours, restaurants & shows… they made a big difference in helping make it a great vacation! Thanks, ladies!",
    image: '/facebook-logo-round.jpg',
  },
]
