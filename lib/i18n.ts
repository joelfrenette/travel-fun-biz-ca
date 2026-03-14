import type { Language } from '@/lib/preferences'

const translations: Record<Language, Record<string, string>> = {
  en: {},
  fr: {
    'Travel Agents': 'Agents de voyage',
    'In The News': 'Dans les médias',
    'About Us': 'À propos',
    'Contact Us': 'Nous joindre',
    'Booking': 'Réservations',
    'Get Started': 'Commencer',
    'Explore Packages': 'Voir les forfaits',
    'Plan My Trip': 'Planifier mon voyage',
    'Featured Travel Packages': 'Forfaits de voyage en vedette',
    'Discover handpicked destinations and experiences tailored for unforgettable adventures.':
      'Découvrez des destinations et des expériences soigneusement sélectionnées pour créer des souvenirs inoubliables.',
    'All': 'Tous',
    'No packages available at the moment. Check back soon!': 'Aucun forfait pour le moment. Revenez bientôt!',
    'Why Choose TravelFunBiz.CA': 'Pourquoi choisir TravelFunBiz.CA',
    "When you work with us, you save time, you save stress, you save money. We take care of all the hard work with a FREE dedicated experience concierge. That's right—you don't pay more! We meet or beat what you can get on your own. We get paid by the suppliers for bringing them millions in business, and we get group rates and exclusive offers that we pass on to YOU.":
      "Avec nous, vous économisez du temps, du stress et de l'argent. Nous nous occupons de tout grâce à un concierge d'expérience GRATUIT. Vous ne payez pas plus! Nous égalons ou surpassons ce que vous trouvez seul. Les fournisseurs nous paient grâce au volume que nous leur apportons et nous vous transférons nos tarifs de groupe et offres exclusives.",
    'Save Time': 'Gagnez du temps',
    'We take care of all the hard work so you can focus on enjoying your trip.':
      'Nous prenons en charge tous les détails pour que vous puissiez profiter de votre voyage.',
    'Save Stress': 'Moins de stress',
    'Relax knowing every detail is handled by experienced travel professionals.':
      'Détendez-vous, chaque détail est géré par des professionnels expérimentés.',
    'Save Money': 'Économisez',
    'Get the best value with our exclusive deals and insider supplier connections.':
      'Profitez d’offres exclusives et de nos relations privilégiées avec les fournisseurs.',
    'Dedicated Travel Concierge': 'Concierge de voyage dédié',
    'Your personal concierge trained in CRM and AI, specialized in locations and suppliers.':
      'Votre concierge personnel, formé en CRM et en IA, spécialisé par destinations et fournisseurs.',
    'What Our Travelers Say': 'Ce que disent nos voyageurs',
    "Don't just take our word for it. Here's what our happy travelers have to say about their experiences.":
      'Ne nous croyez pas sur parole. Voici ce que nos voyageurs satisfaits racontent.',
    'Google Review': 'Avis Google',
    'Facebook Review': 'Avis Facebook',
    'Get Your Free Travel Concierge': 'Obtenez votre concierge voyage gratuit',
    'Ready to explore the world? Fill out the form below and let us help you plan your dream vacation.':
      'Prêt à explorer le monde? Remplissez le formulaire ci-dessous et laissez-nous planifier votre voyage de rêve.',
    'Plan Your Perfect Trip': 'Planifiez votre voyage parfait',
    'Fill out the form below and our travel experts will contact you shortly.':
      'Remplissez le formulaire et nos experts communiqueront avec vous rapidement.',
    'Full Name': 'Nom complet',
    'Email': 'Courriel',
    'Phone Number': 'Numéro de téléphone',
    'Interested Package': 'Forfait souhaité',
    'Preferred Travel Date': 'Date de voyage désirée',
    'Number of Travelers': 'Nombre de voyageurs',
    'Additional Information': 'Informations supplémentaires',
    'Submit Inquiry': 'Envoyer la demande',
    'Submitting...': 'Envoi en cours...',
    'Success!': 'Succès!',
    "We've received your inquiry and will contact you soon.": 'Nous avons reçu votre demande et vous contacterons sous peu.',
    'Submit Another Inquiry': 'Envoyer une autre demande',
    'By submitting this form, you agree to our privacy policy and terms of service.':
      'En soumettant ce formulaire, vous acceptez notre politique de confidentialité et nos conditions d’utilisation.',
    'Select a package': 'Choisissez un forfait',
    'Select number': 'Choisissez un nombre',
    '1 Person': '1 personne',
    '2 People': '2 personnes',
    '3-4 People': '3-4 personnes',
    '5-8 People': '5-8 personnes',
    '9+ People': '9 personnes et plus',
    'Additional Information...': 'Parlez-nous de vos préférences, exigences ou questions...',
    'What is Your Full Name *': 'Quel est votre nom complet *',
    'Enter Your Email *': 'Votre courriel *',
    'Mobile Phone *': 'Cellulaire *',
    'Which deals you like? (multi-select) *': 'Quels types d’offres vous intéressent? (sélection multiple) *',
    'SUBMIT': 'SOUMETTRE',
    'NOTIFY ME OF TRAVEL DEALS': 'Informez-moi des offres voyages',
    'per person': 'par personne',
    'More Info': "Plus d'infos",
    'Luxury': 'Luxe',
    'Groups': 'Groupes',
    'Adventure': 'Aventure',
    'Wellness': 'Bien-être',
    'Singles': 'Voyages en solo',
    'All-Inclusive Resorts': 'Tout-inclus',
    'Cruises': 'Croisières',
    'European Tours': 'Circuits européens',
    'Adventure Travel': 'Voyages d’aventure',
    'Luxury Escapes': 'Escapades de luxe',
    'Specializing in luxury travel, group adventures, and singles vacations. From tropical paradises to cultural expeditions, your perfect journey awaits.':
      'Spécialistes des voyages de luxe, des escapades de groupe et des vacances pour voyageurs solos. Des paradis tropicaux aux expéditions culturelles, votre aventure idéale vous attend.',
    'Signed in as': 'Connecté en tant que',
    'per person.': 'par personne.',
    'Ready to explore the world? Fill out the form below and let us help you plan your dream vacation. (duplicate)':
      'Prêt à explorer le monde? Remplissez le formulaire ci-dessous et laissez-nous planifier votre voyage de rêve.',
    'We will keep you posted with the latest travel deals.': 'Nous vous tiendrons informé des dernières offres voyages.',
    'Subscribed!': 'Inscription confirmée!',
    'Subscription failed': 'Échec de l’inscription',
    'Please try again in a moment.': 'Veuillez réessayer dans un instant.',
    'Language': 'Langue',
    'Currency': 'Devise',
    'USD': 'USD',
    'CAD': 'CAD',
    'EN': 'EN',
    'FR': 'FR',
    'Tropical Paradise Escape': 'Évasion paradisiaque',
    'European Heritage Tour': 'Circuit patrimoine européen',
    'Mountain Adventure Trek': 'Randonnée d’aventure en montagne',
    'Wellness Retreat & Spa': 'Retraite bien-être et spa',
    'Singles Getaway Experience': 'Escapade pour voyageurs solos',
    'Amazon Rainforest Expedition': 'Expédition dans la forêt amazonienne',
    'Experience luxury in overwater bungalows with crystal-clear waters, pristine beaches, and world-class diving.':
      'Séjour de luxe en villa sur l’eau avec plages immaculées et plongée de classe mondiale.',
    'Explore ancient ruins, Renaissance art, and culinary delights across Rome, Florence, and Paris.':
      'Découvrez ruines antiques, art de la Renaissance et gastronomie à Rome, Florence et Paris.',
    'Trek through the Himalayas, visit ancient monasteries, and witness breathtaking mountain vistas.':
      'Randonnée dans l’Himalaya, visites de monastères anciens et panoramas grandioses.',
    'Rejuvenate your mind and body with yoga, meditation, spa treatments, and healthy cuisine in paradise.':
      'Rechargez corps et esprit avec yoga, méditation, soins spa et cuisine santé sous les tropiques.',
    'Connect with like-minded travelers, enjoy adventure activities, and explore stunning beaches and rainforests.':
      'Rencontrez des voyageurs partageant vos intérêts, vivez des aventures et explorez plages et forêts tropicales.',
    "Explore the world's largest rainforest, encounter exotic wildlife, and learn from indigenous guides.":
      'Explorez la plus grande forêt tropicale, observez une faune exotique et apprenez des guides autochtones.',
  },
}

export function translate(text: string, language: Language): string {
  if (language === 'fr') {
    return translations.fr[text] ?? text
  }
  return text
}
